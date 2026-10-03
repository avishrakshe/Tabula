/**
 * Key custody. Agents never receive keys: each agent has a funding wallet (channel `payer`) and a
 * voucher key (channel `authorized_signer`), both generated into the gitignored keys/ folder and held
 * only by the gateway. The Tabula operator key pays fees for Tabula-side transactions (forced close,
 * sweeps, anchoring).
 *
 * The voucher keys are reachable only through `GuardedVoucherSigner.sign`, which accepts a one-time
 * `Approval` minted by the policy service for exactly one (channel, cumulative) pair, and re-checks
 * the hard invariants itself: agent not killed, cumulative strictly increasing, cumulative <= deposit.
 */

import type { Address, KeyPairSigner } from '@solana/kit'
import { DEFAULT_SESSION_EXPIRES_AT, type SignedVoucher } from '@solana/mpp/client'
import { loadOrCreateKeypair, signatureToBase58, signVoucher } from '@tabula/solana'

export interface AgentKeys {
  readonly payer: KeyPairSigner
  readonly voucher: KeyPairSigner
}

export class Custody {
  readonly #agents = new Map<string, AgentKeys>()
  private constructor(readonly operator: KeyPairSigner) {}

  static async load(): Promise<Custody> {
    return new Custody(await loadOrCreateKeypair('tabula-operator'))
  }

  async agentKeys(agentId: string): Promise<AgentKeys> {
    let k = this.#agents.get(agentId)
    if (!k) {
      k = {
        payer: await loadOrCreateKeypair(`agent-${agentId}-payer`),
        voucher: await loadOrCreateKeypair(`agent-${agentId}-voucher`),
      }
      this.#agents.set(agentId, k)
    }
    return k
  }
}

/** Proof that the policy engine allowed exactly this voucher. Single use, short lived. */
export interface Approval {
  readonly agentId: string
  readonly sessionId: string
  readonly channelId: string
  readonly cumulative: bigint
  readonly issuedAt: number
}

const issued = new WeakSet<Approval>()
const APPROVAL_TTL_MS = 5_000

/** Only the policy service calls this, right after `evaluate` returned `allow`. */
export function issueApproval(a: Omit<Approval, 'issuedAt'>): Approval {
  const approval = Object.freeze({ ...a, issuedAt: Date.now() })
  issued.add(approval)
  return approval
}

export class SignerRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignerRefusal'
  }
}

interface ChannelGuard {
  readonly agentId: string
  deposit: bigint
  lastSigned: bigint
}

export class GuardedVoucherSigner {
  readonly #killed = new Set<string>()
  readonly #channels = new Map<string, ChannelGuard>()
  #globalKill = false

  constructor(private readonly custody: Custody) {}

  registerChannel(channelId: string, agentId: string, deposit: bigint, signedCumulative: bigint): void {
    this.#channels.set(channelId, { agentId, deposit, lastSigned: signedCumulative })
  }

  updateDeposit(channelId: string, deposit: bigint): void {
    const g = this.#channels.get(channelId)
    if (g && deposit > g.deposit) g.deposit = deposit
  }

  forgetChannel(channelId: string): void {
    this.#channels.delete(channelId)
  }

  /** First step of every kill: from here on this agent's keys sign nothing. */
  markKilled(agentId: string): void {
    this.#killed.add(agentId)
  }

  revive(agentId: string): void {
    this.#killed.delete(agentId)
  }

  setGlobalKill(on: boolean): void {
    this.#globalKill = on
  }

  isKilled(agentId: string): boolean {
    return this.#globalKill || this.#killed.has(agentId)
  }

  lastSigned(channelId: string): bigint | undefined {
    return this.#channels.get(channelId)?.lastSigned
  }

  async sign(approval: Approval): Promise<SignedVoucher> {
    if (!issued.has(approval))
      throw new SignerRefusal('approval was not issued by the policy engine or was already used')
    issued.delete(approval)
    if (Date.now() - approval.issuedAt > APPROVAL_TTL_MS) throw new SignerRefusal('approval expired')
    if (this.isKilled(approval.agentId)) throw new SignerRefusal(`agent ${approval.agentId} is stopped`)
    const guard = this.#channels.get(approval.channelId)
    if (!guard || guard.agentId !== approval.agentId)
      throw new SignerRefusal('channel is not registered to this agent')
    if (approval.cumulative <= guard.lastSigned) throw new SignerRefusal('cumulative must strictly increase')
    if (approval.cumulative > guard.deposit)
      throw new SignerRefusal('cumulative would exceed the channel deposit')

    const { voucher: key } = await this.custody.agentKeys(approval.agentId)
    const expiresAt = BigInt(DEFAULT_SESSION_EXPIRES_AT)
    const signed = await signVoucher(key, {
      channelId: approval.channelId as Address,
      cumulativeAmount: approval.cumulative,
      expiresAt,
    })
    guard.lastSigned = approval.cumulative
    return {
      signature: signatureToBase58(signed.signature),
      signatureType: 'ed25519',
      signer: key.address,
      voucher: {
        channelId: approval.channelId,
        cumulativeAmount: approval.cumulative.toString(),
        expiresAt: DEFAULT_SESSION_EXPIRES_AT,
      },
    }
  }
}
