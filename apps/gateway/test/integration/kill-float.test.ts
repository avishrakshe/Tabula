/**
 * Milestone 3 on the Payment Sandbox, with the real onchain ceiling: a Squads vault funds per-agent
 * Subscriptions-program allowances. Proves the kill path (cooperative and forced), that refunds land
 * back in the vault, and that the idle sweep reclaims float. Ends with exact vault accounting:
 * vault_after = vault_before - sum(settled onchain).
 */
import { address } from '@solana/kit'
import { reconcileChannel, schema } from '@tabula/ledger'
import { eq } from '@tabula/ledger/sql'
import { fetchChannelView } from '@tabula/solana'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Harness, sandboxReachable, startHarness } from './harness.js'

const reachable = await sandboxReachable()
let h: Harness
let vaultStart = 0n

async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 120_000,
  stepMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

const vaultBalance = async () => BigInt((await h.gw.treasury.vaultBalance()) ?? 0n)
const allowanceOf = async (agentId: string) => (await h.gw.treasury.allowance(agentId))!

describe.skipIf(!reachable)('kill path and float manager with the onchain ceiling', () => {
  beforeAll(async () => {
    h = await startHarness({
      treasury: 'ceiling',
      globalPolicy: { vendors: { allow: ['inference-a', 'inference-b'] } },
      vendorOverrides: { 'inference-a': { noLatency: true }, 'inference-b': { noLatency: true } },
      agents: [
        { id: 'research-01', name: 'Research', role: 'research', department: 'R&D', dailyBudget: 2_000_000 },
        {
          id: 'rogue-01',
          name: 'Rogue',
          role: 'ops',
          department: 'Ops',
          dailyBudget: 2_000_000,
          policy: { velocity: { windowSec: 60, maxUsd: 0.02 }, onViolation: 'kill_and_close' },
        },
        { id: 'slowpay-01', name: 'Slow', role: 'ops', department: 'Ops', dailyBudget: 1_000_000 },
        { id: 'tiny-01', name: 'Tiny', role: 'ops', department: 'Ops', dailyBudget: 500 },
      ],
    })
    expect(h.gw.treasury.kind).toBe('squads-allowance')
    vaultStart = await vaultBalance()
    expect(vaultStart).toBe(100_000_000n)
  })
  afterAll(async () => h?.stop())

  let research: {
    sessionId: string
    channel: string
    deposit: string
    unitsPerCall: number
    unitPrice: string
  }

  it('pulls each deposit from the vault just in time, through the agent’s onchain allowance', async () => {
    const before = await allowanceOf('research-01')
    expect(before.perPeriod).toBe(2_000_000n)
    const res = await h.call('research-01', 'POST', '/v1/sessions', {
      vendorId: 'inference-a',
      taskId: 'r-1',
    })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    research = res.json
    expect(research.deposit).toBe('500000') // min(available $2.00, 500 calls x $0.001)
    const after = await allowanceOf('research-01')
    expect(before.remaining - after.remaining).toBe(500_000n)
    expect(await vaultBalance()).toBe(vaultStart - 500_000n)
    const pull = (
      await h.gw.ledger.db.select().from(schema.events).where(eq(schema.events.agentId, 'research-01'))
    ).find((e) => e.type === 'top_up')
    expect(pull?.txSignature).toBeTruthy()
    for (let i = 0; i < 20; i++) {
      const v = await h.call('research-01', 'POST', `/v1/sessions/${research.sessionId}/voucher`, {
        units: research.unitsPerCall,
        unitPrice: research.unitPrice,
      })
      expect(v.status).toBe(200)
    }
  })

  it('refuses to open a channel the onchain allowance cannot fund', async () => {
    const res = await h.call('tiny-01', 'POST', '/v1/sessions', { vendorId: 'inference-a', taskId: 't-1' })
    expect(res.status).toBe(402)
    expect(res.json.error).toBe('ONCHAIN_CEILING')
    expect(res.json.message).toMatch(/allowance has \$0\.0005 left/)
    expect(await vaultBalance()).toBe(vaultStart - 500_000n)
  })

  it('kill path: blocked voucher never signed, channel settled at the last signed voucher, refund swept back to the vault', async () => {
    const vaultBefore = await vaultBalance()
    const open = await h.call('rogue-01', 'POST', '/v1/sessions', { vendorId: 'inference-b', taskId: 'g-1' })
    expect(open.status, JSON.stringify(open.json)).toBe(201)
    const s = open.json
    let blockedAt = -1
    for (let i = 1; i <= 30 && blockedAt < 0; i++) {
      const r = await h.call('rogue-01', 'POST', `/v1/sessions/${s.sessionId}/voucher`, {
        units: s.unitsPerCall,
        unitPrice: s.unitPrice,
      })
      if (r.status === 402) blockedAt = i
    }
    expect(blockedAt).toBe(17)
    const sweep = await waitFor(async () =>
      (await h.gw.ledger.db.select().from(schema.events).where(eq(schema.events.agentId, 'rogue-01'))).find(
        (e) => e.type === 'sweep' && e.txSignature,
      ),
    )
    expect(sweep.message).toMatch(/back to the treasury vault/)
    const channel = (await h.gw.store.channel(s.sessionId))!
    expect(channel).toMatchObject({ status: 'refunded', settledAmount: 16 * 1250 })
    // the vault got everything back except what the vendor actually earned
    expect(await vaultBalance()).toBe(vaultBefore - 16n * 1250n)
    const timeline = (
      await h.gw.ledger.db.select().from(schema.events).where(eq(schema.events.agentId, 'rogue-01'))
    ).map((e) => e.type)
    expect(timeline).toEqual(
      expect.arrayContaining(['top_up', 'session_opened', 'agent_killed', 'session_closed', 'sweep']),
    )
  })

  it('forced close when the vendor is unreachable: request_close, grace period, seal, distribute, sweep', async () => {
    const vaultBefore = await vaultBalance()
    const open = await h.call('slowpay-01', 'POST', '/v1/sessions', {
      vendorId: 'inference-b',
      taskId: 's-1',
    })
    expect(open.status, JSON.stringify(open.json)).toBe(201)
    const s = open.json
    for (let i = 0; i < 3; i++) {
      const r = await h.call('slowpay-01', 'POST', `/v1/sessions/${s.sessionId}/voucher`, {
        units: s.unitsPerCall,
        unitPrice: s.unitPrice,
      })
      expect(r.status).toBe(200)
    }
    h.vendors['inference-b']!.setDown(true)
    try {
      const kill = await h.admin('POST', '/v1/kill', { agentId: 'slowpay-01', reason: 'operator test' })
      expect(kill.status, JSON.stringify(kill.json)).toBe(200)
      expect(kill.json.closed[0]).toMatchObject({ mode: 'forced' })
    } finally {
      h.vendors['inference-b']!.setDown(false)
    }
    const channel = (await h.gw.store.channel(s.sessionId))!
    // the vendor never settled, so after the grace period nothing could be claimed: full refund
    expect(channel).toMatchObject({ status: 'refunded', settledAmount: 0, refundedAmount: channel.deposit })
    const recon = reconcileChannel({
      ledgerSigned: BigInt(channel.signedCumulative),
      deposit: BigInt(channel.deposit),
      settled: 0n,
      refunded: true,
    })
    expect(recon.status).toBe('LEDGER_AHEAD') // signed vouchers the vendor left unclaimed
    const steps = (
      await h.gw.ledger.db.select().from(schema.events).where(eq(schema.events.channelId, s.sessionId))
    ).map((e) => e.message)
    expect(steps.join('\n')).toMatch(/Requested a forced close[\s\S]*sealed the channel[\s\S]*Refunded/)
    expect(await vaultBalance()).toBe(vaultBefore)
  })

  it('idle sweep closes idle channels and reclaims their float into the vault', async () => {
    const floatBefore = await h.admin('GET', '/v1/float')
    expect(floatBefore.json.escrowTiedUp).toBe(String(500_000 - 20 * 1000))
    const sweep = await h.admin('POST', '/v1/float/sweep', { idleSeconds: 0 })
    expect(sweep.status, JSON.stringify(sweep.json)).toBe(200)
    expect(sweep.json.closed).toHaveLength(1)
    expect(sweep.json.reclaimedFromEscrow).toBe('480000')
    const floatAfter = await h.admin('GET', '/v1/float')
    expect(floatAfter.json.escrowTiedUp).toBe('0')
    const view = await fetchChannelView(h.gw.rpc, address(research.channel))
    expect(view.settled === 20_000n || view.statusName === 'closed').toBe(true)
    // every dollar accounted for: the vault is down by exactly what vendors settled onchain
    expect(await vaultBalance()).toBe(vaultStart - 20n * 1000n - 16n * 1250n)
  })
})
