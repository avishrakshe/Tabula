/**
 * End-to-end against the Solana Payment Sandbox: real vendors (stock @solana/mpp session server),
 * real gateway, real payment channels. Run with `pnpm --filter @tabula/gateway test:integration`.
 */

import { address } from '@solana/kit'
import { buildOpenPaymentChannelTransaction, type SessionChallenge } from '@solana/mpp/client'
import { reconcileChannel, schema } from '@tabula/ledger'
import { ephemeralKeypair, fetchChannelView, setSolBalance, setTokenBalance } from '@tabula/solana'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { simulateOpen } from '../../src/challenge.js'
import { fetchChallenge } from '../../src/mpp-client.js'
import { type Harness, sandboxReachable, startHarness } from './harness.js'

const reachable = await sandboxReachable()
let h: Harness

describe.skipIf(!reachable)('gateway on the Payment Sandbox', () => {
  beforeAll(async () => {
    h = await startHarness({
      globalPolicy: { vendors: { allow: ['inference-a', 'inference-b'] }, maxUnitPriceUsd: 0.00001 },
      vendorOverrides: { 'inference-a': { noLatency: true } },
      agents: [
        {
          id: 'research-01',
          name: 'Research',
          role: 'research',
          department: 'R&D',
          dailyBudget: 25_000_000,
          policy: { dailyBudgetUsd: 25, perTaskBudgetUsd: 5, velocity: { windowSec: 60, maxUsd: 2 } },
        },
        {
          id: 'rogue-01',
          name: 'Rogue',
          role: 'ops',
          department: 'Ops',
          dailyBudget: 5_000_000,
          policy: { velocity: { windowSec: 60, maxUsd: 0.02 }, onViolation: 'kill_and_close' },
        },
        { id: 'coder-01', name: 'Coder', role: 'coding', department: 'Eng', dailyBudget: 10_000_000 },
      ],
    })
  })
  afterAll(async () => h?.stop())

  let research: {
    sessionId: string
    channel: string
    deposit: string
    pricePerCall: string
    unitsPerCall: number
    unitPrice: string
  }

  it('opens a channel after verifying the 402 challenge; the Tabula key is the onchain voucher signer', async () => {
    const res = await h.call('research-01', 'POST', '/v1/sessions', {
      vendorId: 'inference-a',
      taskId: 'research-task-1',
      taskType: 'summarize',
    })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    research = res.json
    expect(research.pricePerCall).toBe('1000')
    expect(research.unitsPerCall).toBe(500)
    const view = await fetchChannelView(h.gw.rpc, address(research.channel))
    const keys = await h.gw.custody.agentKeys('research-01')
    expect(view.statusName).toBe('open')
    expect(view.data?.authorizedSigner).toBe(keys.voucher.address)
    expect(view.data?.payer).toBe(keys.payer.address)
    expect(view.data?.payee).toBe(h.vendors['inference-a']!.payee)
    expect(view.deposit).toBe(BigInt(research.deposit))
    const checks = await h.gw.ledger.db.select().from(schema.challengeChecks)
    expect(checks.at(-1)).toMatchObject({ verdict: 'OK', simulationOk: true })
  })

  it('refuses to pay a different amount than the verified challenge price', async () => {
    const res = await h.call('research-01', 'POST', `/v1/sessions/${research.sessionId}/voucher`, {
      units: 600,
      unitPrice: '2',
    })
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('AMOUNT_MISMATCH')
  })

  it('streams 500 vouchers through policy, signer and vendor', async () => {
    for (let i = 1; i <= 500; i++) {
      const res = await h.call('research-01', 'POST', `/v1/sessions/${research.sessionId}/voucher`, {
        units: research.unitsPerCall,
        unitPrice: research.unitPrice,
        prompt: `paper ${i}`,
        requestId: `r-${i}`,
      })
      expect(res.status, JSON.stringify(res.json)).toBe(200)
      expect(res.json.cumulative).toBe(String(i * 1000))
    }
    // an agent retry with the same requestId is answered from the ledger, not signed again
    const retry = await h.call('research-01', 'POST', `/v1/sessions/${research.sessionId}/voucher`, {
      units: research.unitsPerCall,
      unitPrice: research.unitPrice,
      requestId: 'r-500',
    })
    expect(retry.json).toMatchObject({ replayed: true, cumulative: '500000' })
    const rows = await h.gw.ledger.db
      .select()
      .from(schema.vouchers)
      .where(eq(schema.vouchers.channelId, research.sessionId))
    expect(rows).toHaveLength(500)
    expect(rows.every((r) => r.verdict === 'signed' && r.signature && r.responseStatus)).toBe(true)
    expect(rows.reduce((a, r) => a + r.delta, 0)).toBe(500_000)
    // the escrow is now used up: the next voucher is refused (top-up needed), not signed
    const over = await h.call('research-01', 'POST', `/v1/sessions/${research.sessionId}/voucher`, {
      units: research.unitsPerCall,
      unitPrice: research.unitPrice,
    })
    expect(over.status).toBe(402)
    expect(over.json).toMatchObject({ rule: 'CHANNEL_DEPOSIT', action: 'block' })
    expect(h.gw.policy.agentStatus('research-01')).toBe('active')
  })

  it('blocks a prompt-injected payee swap before anything is signed (PAYEE_MISMATCH)', async () => {
    const before = (await h.gw.store.channels()).length
    const mirror = `${h.vendors.mirror!.url}/v1/infer`
    const res = await h.call('coder-01', 'POST', '/v1/sessions', {
      vendorId: 'inference-a',
      taskId: 'coder-task-1',
      endpoint: mirror,
    })
    expect(res.status).toBe(403)
    expect(res.json).toMatchObject({ error: 'PAYMENT_REQUEST_REJECTED', verdict: 'PAYEE_MISMATCH' })
    expect(res.json.message).toMatch(/registered to/)
    expect((await h.gw.store.channels()).length).toBe(before)
    const checks = await h.gw.ledger.db
      .select()
      .from(schema.challengeChecks)
      .where(eq(schema.challengeChecks.agentId, 'coder-01'))
    expect(checks.at(-1)).toMatchObject({
      verdict: 'PAYEE_MISMATCH',
      payeeOffered: h.vendors.mirror!.payee,
      payeeExpected: h.vendors['inference-a']!.payee,
    })
    // falling back to the registered vendor works
    const ok = await h.call('coder-01', 'POST', '/v1/sessions', {
      vendorId: 'inference-a',
      taskId: 'coder-task-1',
    })
    expect(ok.status, JSON.stringify(ok.json)).toBe(201)
  })

  it('a simulated open that would spend the agent wallet’s SOL is caught (SIMULATION_MISMATCH)', async () => {
    const challenge = (await fetchChallenge(
      `${h.vendors['inference-a']!.url}/v1/infer`,
      5_000,
    )) as SessionChallenge
    const payer = await ephemeralKeypair()
    const voucher = await ephemeralKeypair()
    await setSolBalance(h.cluster.rpcUrl, payer.address, 1_000_000_000n)
    await setTokenBalance(h.cluster.rpcUrl, payer.address, h.cluster.defaultMint!, 1_000_000n)
    // a malicious challenge that does not sponsor fees makes the agent wallet pay fee + rent
    const hostile = {
      ...challenge,
      request: {
        ...challenge.request,
        methodDetails: { ...challenge.request.methodDetails, feePayer: false, feePayerKey: undefined },
      },
    } as SessionChallenge
    const open = await buildOpenPaymentChannelTransaction({
      authorizedSigner: voucher.address,
      deposit: 100_000n,
      request: hostile.request,
      signer: payer,
    })
    const sim = await simulateOpen(h.gw.rpc, {
      transaction: open.transaction,
      payer: payer.address,
      channel: address(open.channelId),
      mint: h.cluster.defaultMint!,
      deposit: 100_000n,
    })
    expect(sim.ok).toBe(false)
    expect(sim.reason).toMatch(/SOL/)
    // and the honest version passes
    const honest = await buildOpenPaymentChannelTransaction({
      authorizedSigner: voucher.address,
      deposit: 100_000n,
      request: challenge.request,
      signer: payer,
    })
    const sim2 = await simulateOpen(h.gw.rpc, {
      transaction: honest.transaction,
      payer: payer.address,
      channel: address(honest.channelId),
      mint: h.cluster.defaultMint!,
      deposit: 100_000n,
    })
    expect(sim2, sim2.reason).toMatchObject({
      ok: true,
      payerTokenDelta: -100_000n,
      escrowTokenAfter: 100_000n,
      payerLamportsDelta: 0n,
    })
  })

  it('velocity trips on a specific voucher: it is never signed, the agent is killed, its channel closes', async () => {
    const open = await h.call('rogue-01', 'POST', '/v1/sessions', {
      vendorId: 'inference-b',
      taskId: 'rogue-task-1',
    })
    expect(open.status, JSON.stringify(open.json)).toBe(201)
    const s = open.json
    let blockedAt = -1
    for (let i = 1; i <= 40; i++) {
      const res = await h.call('rogue-01', 'POST', `/v1/sessions/${s.sessionId}/voucher`, {
        units: s.unitsPerCall,
        unitPrice: s.unitPrice,
      })
      if (res.status === 402) {
        blockedAt = i
        expect(res.json).toMatchObject({
          error: 'POLICY_VIOLATION',
          rule: 'VELOCITY',
          action: 'kill_and_close',
        })
        expect(res.json.message).toMatch(/^Stopped paying rogue-01: spent \$0\.021 in 60s \(limit \$0\.02\)$/)
        break
      }
      expect(res.status, JSON.stringify(res.json)).toBe(200)
    }
    expect(blockedAt).toBe(14) // 13 x $0.0015 = $0.0195 fits; the 14th would reach $0.021
    // nothing more is ever signed for this agent
    const after = await h.call('rogue-01', 'POST', `/v1/sessions/${s.sessionId}/voucher`, {
      units: s.unitsPerCall,
      unitPrice: s.unitPrice,
    })
    expect([402, 403, 409]).toContain(after.status)
    const rows = await h.gw.ledger.db
      .select()
      .from(schema.vouchers)
      .where(eq(schema.vouchers.agentId, 'rogue-01'))
    const blocked = rows.filter((r) => r.verdict === 'blocked')
    expect(blocked[0]).toMatchObject({
      ruleTriggered: 'VELOCITY',
      signature: null,
      cumulativeAmount: 14 * 1500,
    })
    const signed = rows.filter((r) => r.verdict === 'signed')
    expect(signed).toHaveLength(13)
    expect(Math.max(...signed.map((r) => r.cumulativeAmount))).toBe(13 * 1500)
    // the kill path closes the channel at the last signed voucher and the remainder comes back
    let channel = await h.gw.store.channel(s.sessionId)
    for (let i = 0; i < 60 && channel?.status !== 'refunded' && channel?.status !== 'sealed'; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      channel = await h.gw.store.channel(s.sessionId)
    }
    expect(channel?.status).toBe('refunded')
    expect(channel?.settledAmount).toBe(13 * 1500)
    expect(channel?.refundedAmount).toBe(channel!.deposit - 13 * 1500)
    const view = await fetchChannelView(h.gw.rpc, address(s.channel))
    expect(view.settled === 13n * 1500n || view.statusName === 'closed').toBe(true)
    expect((await h.gw.store.agent('rogue-01'))?.status).toBe('killed')
    const events = await h.gw.ledger.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.agentId, 'rogue-01'))
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['agent_killed', 'session_closed']))
  })

  it('closes cooperatively, settles exactly what was signed and reconciles MATCHED', async () => {
    const res = await h.call('research-01', 'POST', `/v1/sessions/${research.sessionId}/close`)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json).toMatchObject({ mode: 'cooperative', settled: '500000' })
    const row = (await h.gw.store.channel(research.sessionId))!
    const view = await fetchChannelView(h.gw.rpc, address(research.channel))
    const settled = view.exists ? view.settled : BigInt(row.settledAmount!)
    const recon = reconcileChannel({
      ledgerSigned: BigInt(row.signedCumulative),
      deposit: BigInt(row.deposit),
      settled,
      refunded: row.status === 'refunded',
    })
    expect(recon.status).toBe('MATCHED')
  })
})
