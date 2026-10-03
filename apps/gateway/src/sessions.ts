import { type Address, address, type KeyPairSigner } from '@solana/kit'
import {
  buildOpenPaymentChannelTransaction,
  DEFAULT_SESSION_EXPIRES_AT,
  type SessionAction,
  type SessionChallenge,
  type SignedVoucher,
} from '@solana/mpp/client'
import type { schema } from '@tabula/ledger'
import { formatUsd, type Remaining } from '@tabula/policy'
import {
  buildDistribute,
  buildRequestClose,
  buildSeal,
  createAtaIdempotentIx,
  explorerAddressUrl,
  explorerTxUrl,
  fetchChannelView,
  type SolanaRpc,
  sendAndConfirm,
} from '@tabula/solana'
import { type ChallengeCheck, simulateOpen, verifyChallengeFields } from './challenge.js'
import type { GatewayConfig } from './config.js'
import { type Custody, type GuardedVoucherSigner, SignerRefusal } from './custody.js'
import type { EventBus } from './events.js'
import {
  authorizedCall,
  type CallResult,
  challengeExpiring,
  credentialFor,
  fetchChallenge,
  parseReceipt,
  VendorUnreachableError,
} from './mpp-client.js'
import type { PolicyService } from './policy-service.js'
import type { Store } from './store.js'
import type { Treasury } from './treasury.js'
import { KeyedMutex, newId, sleep, toNum, withTimeout } from './util.js'

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'GatewayError'
  }
}

export interface LiveSession {
  readonly id: string
  readonly agentId: string
  readonly vendorId: string
  readonly taskId: string
  readonly endpoint: string
  readonly channel: Address
  readonly pricePerCall: bigint
  readonly unitsPerCall: number
  deposit: bigint
  signedCumulative: bigint
  challenge: SessionChallenge
  status: 'open' | 'closing' | 'closed'
  lastVoucherAt: number | null
  readonly openedAt: number
}

export interface OpenRequest {
  readonly vendorId: string
  readonly taskId: string
  readonly taskLabel?: string
  readonly taskType?: string
  /** Pay a different endpoint for this vendor (e.g. a "mirror" an agent was told about). Verified like any other. */
  readonly endpoint?: string
  readonly deposit?: bigint
}

export interface VoucherRequestBody {
  readonly units: number
  readonly unitPrice: bigint
  readonly prompt?: string
  readonly requestId?: string
}

export interface VoucherResult {
  readonly paid: true
  readonly voucherId: number
  readonly outcome: CallResult['outcome']
  readonly httpStatus: number | null
  readonly response: unknown
  readonly latencyMs: number
  readonly cumulative: string
  readonly delta: string
  readonly remaining: Record<keyof Remaining, string | null>
  readonly replayed?: boolean
}

export interface CloseResult {
  readonly sessionId: string
  readonly mode: 'cooperative' | 'forced'
  readonly settled: string
  readonly refunded: string
  readonly txSignature: string | null
  readonly explorerUrl: string | null
}

const remainingJson = (r: Remaining): Record<keyof Remaining, string | null> => ({
  task: r.task?.toString() ?? null,
  daily: r.daily?.toString() ?? null,
  velocity: r.velocity?.toString() ?? null,
  channel: r.channel.toString(),
  ceiling: r.ceiling?.toString() ?? null,
})

export class SessionManager {
  readonly #sessions = new Map<string, LiveSession>()
  readonly #sessionLock = new KeyedMutex()
  readonly #agentLock = new KeyedMutex()
  /** Kill/pause work started from a voucher request; drained before shutdown. */
  readonly #background = new Set<Promise<unknown>>()

  constructor(
    private readonly config: GatewayConfig,
    private readonly rpc: SolanaRpc,
    private readonly store: Store,
    private readonly custody: Custody,
    private readonly signer: GuardedVoucherSigner,
    private readonly policy: PolicyService,
    private readonly treasury: Treasury,
    private readonly bus: EventBus,
  ) {}

  get mint(): Address {
    return address(this.config.mint)
  }

  session(id: string): LiveSession | undefined {
    return this.#sessions.get(id)
  }

  #track(p: Promise<unknown>): void {
    const tracked = p.catch((err) => console.error('[gateway] background task failed:', err))
    this.#background.add(tracked)
    void tracked.finally(() => this.#background.delete(tracked))
  }

  /** Waits for in-flight kill/close work (call before closing the ledger). */
  async drain(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background])
  }

  sessions(): LiveSession[] {
    return [...this.#sessions.values()]
  }

  /** Rebuilds live sessions from the ledger after a restart; dangling vendor calls become timeouts. */
  async restore(): Promise<number> {
    const dangling = await this.store.finalizeDangling()
    const open = await this.store.channels(['open', 'closing'])
    for (const row of open) {
      if (!row.channelPda) continue
      const challenge = await fetchChallenge(row.endpoint, this.config.vendorTimeoutMs).catch(() => null)
      const last = await this.store.lastSignedVoucher(row.id)
      const signed = BigInt(last?.cumulativeAmount ?? 0)
      const vendor = await this.store.vendor(row.vendorId)
      const live: LiveSession = {
        id: row.id,
        agentId: row.agentId,
        vendorId: row.vendorId,
        taskId: row.taskId ?? 'unknown',
        endpoint: row.endpoint,
        channel: address(row.channelPda),
        pricePerCall: BigInt(row.pricePerCall),
        unitsPerCall: vendor ? Math.max(1, Math.round(row.pricePerCall / vendor.unitPrice)) : 1,
        deposit: BigInt(row.deposit),
        signedCumulative: signed,
        challenge: challenge as SessionChallenge,
        status: row.status === 'closing' ? 'closing' : 'open',
        lastVoucherAt: row.lastVoucherAt,
        openedAt: row.openedAt,
      }
      this.#sessions.set(row.id, live)
      this.signer.registerChannel(row.channelPda, row.agentId, live.deposit, signed)
    }
    if (dangling) console.log(`[gateway] marked ${dangling} unfinished vendor call(s) as timeouts`)
    return open.length
  }

  // ---------------------------------------------------------------------------------------
  // open
  // ---------------------------------------------------------------------------------------

  async open(agent: schema.AgentRow, req: OpenRequest) {
    if (this.signer.isKilled(agent.id) || this.policy.agentStatus(agent.id) !== 'active') {
      throw new GatewayError(
        403,
        'AGENT_STOPPED',
        `${agent.id} is ${this.policy.globalKill ? 'blocked by the global kill switch' : this.policy.agentStatus(agent.id)}; it cannot open sessions`,
      )
    }
    const vendor = await this.store.vendor(req.vendorId)
    const endpoint = req.endpoint ?? vendor?.endpoint
    if (!endpoint) {
      await this.#rejectChallenge(agent.id, req.vendorId, req.endpoint ?? '(none)', {
        verdict: 'UNKNOWN_VENDOR',
        reason: `"${req.vendorId}" is not in the vendor registry`,
      })
    }
    const policy = this.policy.effectivePolicy(agent.id, req.vendorId)
    if (vendor && !vendor.allowlisted) {
      await this.#rejectChallenge(agent.id, req.vendorId, endpoint!, {
        verdict: 'UNKNOWN_VENDOR',
        reason: `${vendor.name} is not allowlisted`,
      })
    }

    // 1-3. parse the 402 challenge and compare it to the registry
    let challenge: SessionChallenge | null
    try {
      challenge = await fetchChallenge(endpoint!, this.config.vendorTimeoutMs)
    } catch (err) {
      throw new GatewayError(502, 'VENDOR_UNREACHABLE', (err as Error).message)
    }
    if (!challenge) {
      await this.#rejectChallenge(agent.id, req.vendorId, endpoint!, {
        verdict: 'NOT_A_SESSION_CHALLENGE',
        reason: 'the endpoint did not answer with a Solana session payment request',
      })
    }
    const check = verifyChallengeFields(challenge!, vendor, this.config.cluster, req.vendorId)
    if (check.verdict !== 'OK') await this.#rejectChallenge(agent.id, req.vendorId, endpoint!, check)
    const pricePerCall = check.priceOffered!
    const unitsPerCall = check.unitsPerCall!

    // float sizing (M3 adds the onchain ceiling and the p95 of past sessions)
    const keys = await this.custody.agentKeys(agent.id)
    const taskType = req.taskType ?? vendor!.taskType ?? 'general'
    await this.store.ensureTask({
      id: req.taskId,
      agentId: agent.id,
      label: req.taskLabel ?? req.taskId,
      taskType,
      budget: policy.perTaskBudget === null ? null : toNum(policy.perTaskBudget),
    })
    const deposit = await this.#sizeDeposit(agent.id, req, pricePerCall, policy.perTaskBudget)

    const funding = await this.treasury.ensureFunded(agent.id, keys.payer, deposit)
    if (funding.moved > 0n) {
      await this.bus.emit({
        type: funding.source === 'sandbox-faucet' ? 'faucet' : 'top_up',
        agentId: agent.id,
        message: `Funded ${agent.id}'s wallet with ${formatUsd(funding.moved)} from ${funding.source}`,
        txSignature: funding.txSignature ?? null,
        explorerUrl: funding.txSignature ? explorerTxUrl(this.config.cluster, funding.txSignature) : null,
        data: { amount: funding.moved },
      })
    }

    // 4-6. build the open transaction, simulate it, compare balances, sign (payer, partially)
    let opened = await this.#buildOpen(challenge!, keys, deposit)
    const sim = await simulateOpen(this.rpc, {
      transaction: opened.transaction,
      payer: keys.payer.address,
      channel: address(opened.channelId),
      mint: this.mint,
      deposit,
    })
    if (!sim.ok) {
      await this.#rejectChallenge(
        agent.id,
        req.vendorId,
        endpoint!,
        {
          ...check,
          verdict: 'SIMULATION_MISMATCH',
          reason: sim.reason,
        },
        false,
      )
    }
    await this.store.recordChallengeCheck({
      agentId: agent.id,
      vendorId: req.vendorId,
      endpoint: endpoint!,
      payeeExpected: vendor!.payeePubkey,
      payeeOffered: check.payeeOffered ?? null,
      mintExpected: vendor!.mint,
      mintOffered: check.mintOffered ?? null,
      programId: check.programOffered ?? null,
      priceOffered: toNum(pricePerCall),
      simulationOk: true,
      verdict: 'OK',
      reason: `payee, mint, program and price match the registry; ${sim.reason}`,
      ts: Date.now(),
    })

    const sessionId = newId('ses')
    const openedAt = Date.now()
    await this.store.insertChannel({
      id: sessionId,
      channelPda: opened.channelId,
      agentId: agent.id,
      vendorId: req.vendorId,
      taskId: req.taskId,
      endpoint: endpoint!,
      pricePerCall: toNum(pricePerCall),
      payerPubkey: keys.payer.address,
      authorizedSigner: keys.voucher.address,
      deposit: toNum(deposit),
      status: 'opening',
      gracePeriod: opened.gracePeriod,
      openedAt,
    })

    // 7. hand the open credential to the vendor, which co-signs as fee payer and broadcasts
    let res = await this.#sendOpen(endpoint!, challenge!, opened, keys)
    if (res.httpStatus !== 200) {
      // the sandbox occasionally fails a vendor-side RPC call; retry once with a fresh challenge
      await sleep(1_000)
      const fresh = await fetchChallenge(endpoint!, this.config.vendorTimeoutMs).catch(() => null)
      if (fresh && verifyChallengeFields(fresh, vendor, this.config.cluster, req.vendorId).verdict === 'OK') {
        challenge = fresh
        opened = await this.#buildOpen(fresh, keys, deposit)
        await this.store.updateChannel(sessionId, { channelPda: opened.channelId })
        res = await this.#sendOpen(endpoint!, fresh, opened, keys)
      }
    }
    if (res.httpStatus !== 200) {
      await this.store.updateChannel(sessionId, {
        status: 'failed',
        closeReason: `vendor rejected open: ${JSON.stringify(res.body)}`,
      })
      throw new GatewayError(502, 'OPEN_FAILED', `${vendor!.name} did not accept the channel open`, {
        vendorResponse: res.body,
      })
    }

    // confirm onchain that the channel is what we asked for
    const channel = address(opened.channelId)
    const view = await this.#waitForChannel(channel)
    if (
      view.data?.authorizedSigner !== keys.voucher.address ||
      view.deposit !== deposit ||
      view.data?.payee !== vendor!.payeePubkey
    ) {
      await this.store.updateChannel(sessionId, {
        status: 'failed',
        closeReason: 'onchain channel does not match',
      })
      throw new GatewayError(502, 'OPEN_MISMATCH', 'the channel onchain does not match what Tabula signed')
    }
    const openTx = await this.#firstSignature(channel)
    await this.store.updateChannel(sessionId, { status: 'open', openTx })
    this.signer.registerChannel(channel, agent.id, deposit, 0n)
    const live: LiveSession = {
      id: sessionId,
      agentId: agent.id,
      vendorId: req.vendorId,
      taskId: req.taskId,
      endpoint: endpoint!,
      channel,
      pricePerCall,
      unitsPerCall,
      deposit,
      signedCumulative: 0n,
      challenge: challenge!,
      status: 'open',
      lastVoucherAt: null,
      openedAt,
    }
    this.#sessions.set(sessionId, live)
    await this.bus.emit({
      type: 'session_opened',
      agentId: agent.id,
      channelId: sessionId,
      message: `${agent.id} opened a channel with ${vendor!.name}: ${formatUsd(deposit)} in escrow`,
      txSignature: openTx,
      explorerUrl: openTx
        ? explorerTxUrl(this.config.cluster, openTx)
        : explorerAddressUrl(this.config.cluster, channel),
      data: { vendorId: req.vendorId, channel, deposit, pricePerCall, unitsPerCall, endpoint },
    })
    return {
      sessionId,
      channel,
      deposit: deposit.toString(),
      pricePerCall: pricePerCall.toString(),
      unitsPerCall,
      unitPrice: (pricePerCall / BigInt(unitsPerCall)).toString(),
      vendor: { id: vendor!.id, name: vendor!.name, payee: vendor!.payeePubkey },
      explorerUrl: explorerAddressUrl(this.config.cluster, channel),
    }
  }

  async #sizeDeposit(
    agentId: string,
    req: OpenRequest,
    pricePerCall: bigint,
    taskBudget: bigint | null,
  ): Promise<bigint> {
    const candidates: { label: string; value: bigint }[] = [
      { label: 'default (500 calls)', value: pricePerCall * 500n },
    ]
    if (req.deposit) candidates.push({ label: 'requested', value: req.deposit })
    if (taskBudget !== null) candidates.push({ label: 'per-task budget', value: taskBudget })
    const ceiling = await this.treasury.remainingCeiling(agentId)
    if (ceiling !== null) candidates.push({ label: 'remaining onchain allowance', value: ceiling })
    let chosen = candidates[0]!
    for (const c of candidates) if (c.value < chosen.value) chosen = c
    const deposit = chosen.value < pricePerCall ? pricePerCall : chosen.value
    await this.bus.emit({
      type: 'float_sized',
      agentId,
      message: `Sized ${agentId}'s escrow at ${formatUsd(deposit)} (the lesser of ${candidates.map((c) => `${c.label} ${formatUsd(c.value)}`).join(', ')})`,
      data: { deposit, candidates },
    })
    return deposit
  }

  async #buildOpen(
    challenge: SessionChallenge,
    keys: { payer: KeyPairSigner; voucher: KeyPairSigner },
    deposit: bigint,
  ) {
    return buildOpenPaymentChannelTransaction({
      authorizedSigner: keys.voucher.address,
      deposit,
      request: challenge.request,
      signer: keys.payer,
    })
  }

  async #sendOpen(
    endpoint: string,
    challenge: SessionChallenge,
    opened: Awaited<ReturnType<typeof buildOpenPaymentChannelTransaction>>,
    keys: { voucher: KeyPairSigner },
  ): Promise<CallResult> {
    const payload: SessionAction = {
      action: 'open',
      authorizedSigner: keys.voucher.address,
      channelId: opened.channelId,
      depositAmount: opened.deposit,
      gracePeriodSeconds: opened.gracePeriod,
      mint: opened.mint,
      openSlot: opened.openSlot,
      payee: opened.payee,
      payer: opened.payer,
      salt: opened.salt,
      transaction: opened.transaction,
    }
    try {
      return await authorizedCall(
        endpoint,
        credentialFor(challenge, payload),
        Math.max(this.config.vendorTimeoutMs, 30_000),
      )
    } catch (err) {
      return {
        httpStatus: null,
        outcome: 'error',
        body: { error: (err as Error).message },
        latencyMs: 0,
        receipt: null,
        rejected: false,
      }
    }
  }

  async #waitForChannel(channel: Address, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const v = await fetchChannelView(this.rpc, channel)
      if (v.exists || Date.now() > deadline) return v
      await sleep(500)
    }
  }

  async #firstSignature(addr: Address): Promise<string | null> {
    try {
      const sigs = await this.rpc.getSignaturesForAddress(addr, { limit: 10 }).send()
      return sigs.length ? (sigs[sigs.length - 1]!.signature as string) : null
    } catch {
      return null
    }
  }

  async #rejectChallenge(
    agentId: string,
    vendorId: string,
    endpoint: string,
    check: Pick<ChallengeCheck, 'verdict' | 'reason'> & Partial<ChallengeCheck>,
    simulationOk: boolean | null = null,
  ): Promise<never> {
    const vendor = await this.store.vendor(vendorId)
    const row = await this.store.recordChallengeCheck({
      agentId,
      vendorId,
      endpoint,
      payeeExpected: vendor?.payeePubkey ?? null,
      payeeOffered: check.payeeOffered ?? null,
      mintExpected: vendor?.mint ?? null,
      mintOffered: check.mintOffered ?? null,
      programId: check.programOffered ?? null,
      priceOffered: check.priceOffered === undefined ? null : toNum(check.priceOffered),
      simulationOk,
      verdict: check.verdict,
      reason: check.reason,
      ts: Date.now(),
    })
    const message = `Blocked a payment request for ${agentId} before signing anything: ${check.reason}`
    await this.bus.emit({
      type: 'challenge_blocked',
      agentId,
      message,
      data: {
        verdict: check.verdict,
        vendorId,
        endpoint,
        checkId: row.id,
        payeeOffered: check.payeeOffered,
        payeeExpected: vendor?.payeePubkey,
      },
    })
    throw new GatewayError(403, 'PAYMENT_REQUEST_REJECTED', message, {
      verdict: check.verdict,
      reason: check.reason,
      vendorId,
      endpoint,
    })
  }

  // ---------------------------------------------------------------------------------------
  // vouchers
  // ---------------------------------------------------------------------------------------

  async voucher(agentId: string, sessionId: string, body: VoucherRequestBody): Promise<VoucherResult> {
    return this.#sessionLock.run(sessionId, () => this.#voucher(agentId, sessionId, body))
  }

  async #voucher(agentId: string, sessionId: string, body: VoucherRequestBody): Promise<VoucherResult> {
    const s = this.#sessions.get(sessionId)
    if (!s || s.agentId !== agentId)
      throw new GatewayError(404, 'NO_SESSION', `no session ${sessionId} for ${agentId}`)

    if (body.requestId) {
      const prior = await this.store.voucherByRequestId(sessionId, body.requestId)
      if (prior) return this.#replayResult(prior, s)
    }
    if (s.status !== 'open')
      throw new GatewayError(409, 'SESSION_CLOSED', `session ${sessionId} is ${s.status}`)

    // evaluate + sign under the agent lock so concurrent sessions of one agent see each other's spend
    const signedPhase = await this.#agentLock.run(agentId, async () => {
      const ceiling = await this.treasury.remainingCeiling(agentId)
      const channelCeiling = ceiling === null ? null : s.signedCumulative + ceiling
      const { decision, approval } = this.policy.authorize({
        agentId,
        sessionId,
        channelId: s.channel,
        vendorId: s.vendorId,
        taskId: s.taskId,
        units: body.units,
        unitPrice: body.unitPrice,
        deposit: s.deposit,
        signedCumulative: s.signedCumulative,
        ceiling: channelCeiling,
      })
      const now = Date.now()
      if (!approval) {
        const row = await this.store.insertVoucher({
          idempotencyKey: `${sessionId}:blocked:${newId('b')}`,
          requestId: body.requestId ?? null,
          channelId: sessionId,
          agentId,
          taskId: s.taskId,
          vendorId: s.vendorId,
          cumulativeAmount: toNum(decision.newCumulative),
          delta: toNum(decision.delta),
          unitCount: Number.isSafeInteger(body.units) ? body.units : 0,
          unitPrice: toNum(body.unitPrice),
          verdict: 'blocked',
          ruleTriggered: decision.rule ?? null,
          reason: decision.reason ?? null,
          ts: now,
        })
        return { kind: 'blocked' as const, decision, row }
      }
      // the agent must be paying exactly the price the vendor's verified challenge asked for
      if (decision.delta !== s.pricePerCall) {
        throw new GatewayError(
          400,
          'AMOUNT_MISMATCH',
          `this vendor charges ${formatUsd(s.pricePerCall)} per call (${s.unitsPerCall} units); the request was for ${formatUsd(decision.delta)}`,
        )
      }
      let signed: SignedVoucher
      try {
        signed = await this.signer.sign(approval)
      } catch (err) {
        if (err instanceof SignerRefusal) throw new GatewayError(403, 'SIGNER_REFUSED', err.message)
        throw err
      }
      // write-ahead: a signed voucher is claimable, so the ledger records it before it leaves
      const row = await this.store.insertVoucher({
        idempotencyKey: `${sessionId}:${decision.newCumulative}`,
        requestId: body.requestId ?? null,
        channelId: sessionId,
        agentId,
        taskId: s.taskId,
        vendorId: s.vendorId,
        cumulativeAmount: toNum(decision.newCumulative),
        delta: toNum(decision.delta),
        unitCount: body.units,
        unitPrice: toNum(body.unitPrice),
        verdict: 'signed',
        signature: signed.signature,
        ts: now,
      })
      s.signedCumulative = decision.newCumulative
      s.lastVoucherAt = now
      await this.store.updateChannel(sessionId, {
        signedCumulative: toNum(s.signedCumulative),
        lastVoucherAt: now,
      })
      this.policy.recordSigned(agentId, {
        ts: now,
        amount: decision.delta,
        taskId: s.taskId,
        vendorId: s.vendorId,
      })
      return { kind: 'signed' as const, signed, decision, row }
    })

    if (signedPhase.kind === 'blocked') {
      const { decision, row } = signedPhase
      await this.bus.emit({
        type: 'voucher',
        agentId,
        channelId: sessionId,
        message: decision.reason ?? 'blocked',
        data: { row, rule: decision.rule, action: decision.action },
      })
      if (decision.action === 'kill_and_close') {
        this.#track(this.kill(agentId, decision.reason ?? `rule ${decision.rule}`, 'policy'))
      } else if (decision.action === 'pause') {
        this.#track(this.pause(agentId, decision.reason ?? `rule ${decision.rule}`))
      }
      throw new GatewayError(402, 'POLICY_VIOLATION', decision.reason ?? 'blocked by policy', {
        rule: decision.rule,
        action: decision.action,
        remaining: remainingJson(decision.remaining),
        voucherId: row.id,
      })
    }

    const { signed, decision, row } = signedPhase
    // send to the vendor (refresh the challenge first if it is about to expire)
    let result: CallResult
    try {
      if (!s.challenge || challengeExpiring(s.challenge)) await this.#refreshChallenge(s)
      result = await authorizedCall(
        s.endpoint,
        credentialFor(s.challenge, { action: 'voucher', channelId: s.channel, voucher: signed }),
        this.config.vendorTimeoutMs,
        body.prompt ? { prompt: body.prompt } : {},
      )
      if (result.rejected) {
        // a stale challenge is the usual cause; refresh once and resend the same voucher
        await this.#refreshChallenge(s)
        result = await authorizedCall(
          s.endpoint,
          credentialFor(s.challenge, { action: 'voucher', channelId: s.channel, voucher: signed }),
          this.config.vendorTimeoutMs,
          body.prompt ? { prompt: body.prompt } : {},
        )
      }
    } catch (err) {
      // unreachable vendor or changed terms: the voucher is signed and claimable, so it counts as waste
      result = {
        httpStatus: null,
        outcome: 'error',
        body: { error: (err as Error).message },
        latencyMs: 0,
        receipt: null,
        rejected: false,
      }
    }
    const final = await this.store.finalizeVoucher(row.id, {
      responseStatus: result.outcome,
      latencyMs: result.latencyMs,
    })
    await this.bus.emit({
      type: 'voucher',
      agentId,
      channelId: sessionId,
      message: `Paid ${s.vendorId} ${formatUsd(decision.delta)} for ${agentId} (${result.outcome})`,
      data: { row: final },
    })
    return {
      paid: true,
      voucherId: row.id,
      outcome: result.outcome,
      httpStatus: result.httpStatus,
      response: result.body,
      latencyMs: result.latencyMs,
      cumulative: decision.newCumulative.toString(),
      delta: decision.delta.toString(),
      remaining: remainingJson({ ...decision.remaining, channel: s.deposit - s.signedCumulative }),
    }
  }

  #replayResult(prior: schema.VoucherRow, s: LiveSession): VoucherResult {
    if (prior.verdict === 'blocked') {
      throw new GatewayError(402, 'POLICY_VIOLATION', prior.reason ?? 'blocked by policy', {
        rule: prior.ruleTriggered,
        voucherId: prior.id,
        replayed: true,
      })
    }
    return {
      paid: true,
      voucherId: prior.id,
      outcome: (prior.responseStatus ?? 'timeout') as CallResult['outcome'],
      httpStatus: null,
      response: null,
      latencyMs: prior.latencyMs ?? 0,
      cumulative: String(prior.cumulativeAmount),
      delta: String(prior.delta),
      remaining: remainingJson({
        task: null,
        daily: null,
        velocity: null,
        channel: s.deposit - s.signedCumulative,
        ceiling: null,
      }),
      replayed: true,
    }
  }

  async #refreshChallenge(s: LiveSession): Promise<void> {
    const fresh = await fetchChallenge(s.endpoint, this.config.vendorTimeoutMs)
    if (!fresh) throw new VendorUnreachableError(`${s.vendorId} stopped issuing payment requests`)
    const vendor = await this.store.vendor(s.vendorId)
    const check = verifyChallengeFields(fresh, vendor, this.config.cluster, s.vendorId)
    if (check.verdict !== 'OK' || check.priceOffered !== s.pricePerCall) {
      throw new VendorUnreachableError(
        `${s.vendorId} changed its payment terms mid-session (${check.reason})`,
      )
    }
    s.challenge = fresh
  }

  // ---------------------------------------------------------------------------------------
  // close
  // ---------------------------------------------------------------------------------------

  async close(sessionId: string, reason: string, opts: { forceOnly?: boolean } = {}): Promise<CloseResult> {
    return this.#sessionLock.run(sessionId, () => this.#close(sessionId, reason, opts))
  }

  async #close(sessionId: string, reason: string, opts: { forceOnly?: boolean }): Promise<CloseResult> {
    const s = this.#sessions.get(sessionId)
    if (!s) throw new GatewayError(404, 'NO_SESSION', `no session ${sessionId}`)
    if (s.status === 'closed') {
      const row = await this.store.channel(sessionId)
      return {
        sessionId,
        mode: 'cooperative',
        settled: String(row?.settledAmount ?? 0),
        refunded: String(row?.refundedAmount ?? 0),
        txSignature: row?.closeTx ?? null,
        explorerUrl: row?.closeTx ? explorerTxUrl(this.config.cluster, row.closeTx) : null,
      }
    }
    s.status = 'closing'
    await this.store.updateChannel(sessionId, { status: 'closing', closeReason: reason })
    const last = await this.store.lastSignedVoucher(sessionId)

    let result: CloseResult | null = null
    if (last?.signature && !opts.forceOnly) {
      result = await this.#cooperativeClose(s, last).catch(async (err) => {
        await this.bus.emit({
          type: 'kill_step',
          agentId: s.agentId,
          channelId: sessionId,
          message: `Cooperative close with ${s.vendorId} failed (${(err as Error).message}); forcing the close onchain`,
        })
        return null
      })
    }
    if (!result) result = await this.#forcedClose(s, last ? BigInt(last.cumulativeAmount) : 0n)
    s.status = 'closed'
    this.signer.forgetChannel(s.channel)
    await this.bus.emit({
      type: 'session_closed',
      agentId: s.agentId,
      channelId: sessionId,
      message: `Closed ${s.agentId}'s channel with ${s.vendorId} (${result.mode}): settled ${formatUsd(BigInt(result.settled))}, ${formatUsd(BigInt(result.refunded))} back to the agent wallet`,
      txSignature: result.txSignature,
      explorerUrl: result.explorerUrl,
      data: { ...result, reason },
    })
    return result
  }

  async #cooperativeClose(s: LiveSession, last: schema.VoucherRow): Promise<CloseResult> {
    const voucher: SignedVoucher = {
      signature: last.signature!,
      signatureType: 'ed25519',
      signer: (await this.custody.agentKeys(s.agentId)).voucher.address,
      voucher: {
        channelId: s.channel,
        cumulativeAmount: String(last.cumulativeAmount),
        expiresAt: DEFAULT_SESSION_EXPIRES_AT,
      },
    }
    const res = await withTimeout(this.config.cooperativeCloseTimeoutMs, async (signal) => {
      if (!s.challenge || challengeExpiring(s.challenge)) await this.#refreshChallenge(s)
      const r = await fetch(s.endpoint, {
        headers: {
          authorization: credentialFor(s.challenge, { action: 'close', channelId: s.channel, voucher }),
        },
        signal,
      })
      return { status: r.status, receipt: parseReceipt(r), text: await r.text() }
    })
    if (res.status !== 200) throw new Error(`vendor answered ${res.status}: ${res.text.slice(0, 200)}`)
    let txHash = res.receipt?.txHash ?? null
    let { settled, refunded } = await this.#readSettlement(s, BigInt(last.cumulativeAmount))
    if (!refunded) {
      // the vendor sealed but did not distribute: distribute is permissionless, so crank it ourselves
      const tx = await this.#distributeIfSealed(s)
      if (tx) {
        txHash = txHash ?? tx
        ;({ settled, refunded } = await this.#readSettlement(s, BigInt(last.cumulativeAmount), 10_000))
      }
    }
    await this.store.updateChannel(s.id, {
      status: refunded ? 'refunded' : 'sealed',
      settledAmount: toNum(settled),
      refundedAmount: refunded ? toNum(s.deposit - settled) : null,
      closeTx: txHash,
      closedAt: Date.now(),
    })
    return {
      sessionId: s.id,
      mode: 'cooperative',
      settled: settled.toString(),
      refunded: refunded ? (s.deposit - settled).toString() : '0',
      txSignature: txHash,
      explorerUrl: txHash ? explorerTxUrl(this.config.cluster, txHash) : null,
    }
  }

  /** Waits for the vendor's settle+distribute to land, then reads the settled watermark. */
  async #readSettlement(
    s: LiveSession,
    expected: bigint,
    timeoutMs = 30_000,
  ): Promise<{ settled: bigint; refunded: boolean }> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const v = await fetchChannelView(this.rpc, s.channel)
      if (v.statusName === 'distributed') return { settled: v.settled, refunded: true }
      if (v.statusName === 'closed') return { settled: expected, refunded: true }
      if (Date.now() > deadline) return { settled: v.settled, refunded: false }
      await sleep(750)
    }
  }

  async #distributeIfSealed(s: LiveSession): Promise<string | null> {
    const view = await fetchChannelView(this.rpc, s.channel)
    if (view.statusName !== 'sealed' || !view.data) return null
    const operator = this.custody.operator
    const ix = await buildDistribute(this.config.cluster, {
      channel: s.channel,
      payer: view.data.payer,
      payee: view.data.payee,
      mint: view.data.mint,
      rentPayer: view.data.rentPayer,
    })
    return sendAndConfirm(this.rpc, {
      feePayer: operator,
      instructions: [
        await createAtaIdempotentIx(operator, this.config.cluster.treasuryOwner, view.data.mint),
        ix,
      ],
    })
  }

  /**
   * Payer-initiated close for when the vendor is unreachable: request_close, wait out the grace
   * period (the vendor may still settle its best voucher), seal, distribute (refund to the agent
   * wallet). Tabula's operator pays the fees.
   */
  async #forcedClose(s: LiveSession, ledgerSigned: bigint): Promise<CloseResult> {
    const { cluster } = this.config
    const keys = await this.custody.agentKeys(s.agentId)
    const operator = this.custody.operator
    const step = (message: string, tx?: string) =>
      this.bus.emit({
        type: 'kill_step',
        agentId: s.agentId,
        channelId: s.id,
        message,
        txSignature: tx ?? null,
        explorerUrl: tx ? explorerTxUrl(cluster, tx) : null,
      })

    let view = await fetchChannelView(this.rpc, s.channel)
    if (view.statusName === 'open') {
      const tx = await sendAndConfirm(this.rpc, {
        feePayer: operator,
        instructions: [buildRequestClose(cluster, keys.payer, s.channel)],
      })
      await step(
        `Requested a forced close of ${s.agentId}'s channel; grace period ${view.gracePeriod}s starts now`,
        tx,
      )
      view = await fetchChannelView(this.rpc, s.channel)
    }
    if (view.statusName === 'closing') {
      const graceEnds = Number(view.closureStartedAt) * 1000 + view.gracePeriod * 1000
      await sleep(Math.max(0, graceEnds - Date.now()) + 1_000)
      for (let attempt = 0; ; attempt++) {
        view = await fetchChannelView(this.rpc, s.channel)
        if (view.statusName !== 'closing') break
        try {
          const tx = await sendAndConfirm(this.rpc, {
            feePayer: operator,
            instructions: [buildSeal(cluster, s.channel)],
          })
          await step('Grace period over: sealed the channel', tx)
          view = await fetchChannelView(this.rpc, s.channel)
          break
        } catch (err) {
          if (attempt > 30) throw err
          await sleep(3_000) // cluster clock may lag wall clock; retry until the grace period has passed onchain
        }
      }
    }
    let distTx: string | null = null
    if (view.statusName === 'sealed' && view.data) {
      const ix = await buildDistribute(cluster, {
        channel: s.channel,
        payer: view.data.payer,
        payee: view.data.payee,
        mint: view.data.mint,
        rentPayer: view.data.rentPayer,
      })
      distTx = await sendAndConfirm(this.rpc, {
        feePayer: operator,
        instructions: [await createAtaIdempotentIx(operator, cluster.treasuryOwner, view.data.mint), ix],
      })
      await step(
        `Refunded ${formatUsd(view.deposit - view.settled)} of unspent escrow to ${s.agentId}'s wallet`,
        distTx,
      )
    }
    const settled = view.exists ? view.settled : ledgerSigned
    await this.store.updateChannel(s.id, {
      status: 'refunded',
      settledAmount: toNum(settled),
      refundedAmount: toNum(s.deposit - settled),
      closeTx: distTx,
      closedAt: Date.now(),
    })
    return {
      sessionId: s.id,
      mode: 'forced',
      settled: settled.toString(),
      refunded: (s.deposit - settled).toString(),
      txSignature: distTx,
      explorerUrl: distTx ? explorerTxUrl(cluster, distTx) : null,
    }
  }

  // ---------------------------------------------------------------------------------------
  // kill / pause
  // ---------------------------------------------------------------------------------------

  /**
   * Kill path: (1) the signer refuses this agent's keys, (2) status persisted and broadcast,
   * (3) every open channel is closed — cooperatively at the last signed voucher if the vendor
   * answers in time, otherwise forced onchain — and the unspent escrow comes back.
   */
  async kill(
    agentId: string,
    reason: string,
    by: 'policy' | 'operator' = 'operator',
  ): Promise<CloseResult[]> {
    this.signer.markKilled(agentId)
    const already = this.policy.agentStatus(agentId) === 'killed'
    this.policy.setAgentStatus(agentId, 'killed')
    await this.store.setAgentStatus(agentId, 'killed')
    if (!already) {
      await this.bus.emit({
        type: 'agent_killed',
        agentId,
        message: `Stopped ${agentId}: ${reason}`,
        data: { reason, by },
      })
    }
    const open = this.sessions().filter((s) => s.agentId === agentId && s.status === 'open')
    const results: CloseResult[] = []
    for (const s of open) {
      try {
        results.push(await this.close(s.id, `killed: ${reason}`))
      } catch (err) {
        await this.bus.emit({
          type: 'kill_step',
          agentId,
          channelId: s.id,
          message: `Closing ${s.id} failed: ${(err as Error).message}`,
        })
      }
    }
    return results
  }

  async pause(agentId: string, reason: string): Promise<void> {
    if (this.policy.agentStatus(agentId) !== 'active') return
    this.policy.setAgentStatus(agentId, 'paused')
    await this.store.setAgentStatus(agentId, 'paused')
    await this.bus.emit({
      type: 'agent_paused',
      agentId,
      message: `Paused ${agentId}: ${reason}`,
      data: { reason },
    })
  }

  async revive(agentId: string): Promise<void> {
    this.signer.revive(agentId)
    this.policy.setAgentStatus(agentId, 'active')
    await this.store.setAgentStatus(agentId, 'active')
    await this.bus.emit({ type: 'agent_revived', agentId, message: `${agentId} may pay again` })
  }

  async setGlobalKill(on: boolean, by: string): Promise<void> {
    this.signer.setGlobalKill(on)
    this.policy.setGlobalKill(on)
    await this.bus.emit({
      type: on ? 'global_kill' : 'global_unkill',
      message: on
        ? `${by} turned on the global kill switch: no agent payments are signed`
        : `${by} turned off the global kill switch`,
    })
  }
}
