/**
 * Milestone 4 on the Payment Sandbox: onchain receipts (Merkle root per batch via the Memo program),
 * verification against the memo, tamper detection, reconciliation and vendor scorecards, CSV export.
 */
import { merkleRoot, schema } from '@tabula/ledger'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Harness, sandboxReachable, startHarness } from './harness.js'

const reachable = await sandboxReachable()
let h: Harness

describe.skipIf(!reachable)('ledger receipts, reconciliation and scorecards', () => {
  beforeAll(async () => {
    h = await startHarness({
      globalPolicy: { vendors: { allow: ['inference-a', 'inference-b'] } },
      vendorOverrides: { 'inference-a': { noLatency: true }, 'inference-b': { noLatency: true } },
      gateway: { anchorEvery: 0 },
      agents: [
        {
          id: 'research-01',
          name: 'Research',
          role: 'research',
          department: 'R&D',
          dailyBudget: 25_000_000,
          policy: { perTaskBudgetUsd: 0.05 },
        },
        { id: 'coder-01', name: 'Coder', role: 'coding', department: 'Eng', dailyBudget: 25_000_000 },
      ],
    })
  })
  afterAll(async () => h?.stop())

  it('records paid calls with vendor outcomes on two vendors, then closes', async () => {
    for (const [agent, vendor] of [
      ['research-01', 'inference-a'],
      ['coder-01', 'inference-b'],
    ] as const) {
      const open = await h.call(agent, 'POST', '/v1/sessions', { vendorId: vendor, taskId: `${agent}-t0` })
      expect(open.status, JSON.stringify(open.json)).toBe(201)
      const s = open.json
      for (let task = 1; task <= 4; task++) {
        for (let i = 0; i < 10; i++) {
          const r = await h.call(agent, 'POST', `/v1/sessions/${s.sessionId}/voucher`, {
            units: s.unitsPerCall,
            unitPrice: s.unitPrice,
            taskId: `${agent}-task-${task}`,
            taskLabel: `summary ${task}`,
          })
          expect([200, 402]).toContain(r.status)
        }
        await h.call(agent, 'POST', `/v1/tasks/${agent}-task-${task}/complete`, { status: 'completed' })
      }
      const close = await h.call(agent, 'POST', `/v1/sessions/${s.sessionId}/close`)
      expect(close.status, JSON.stringify(close.json)).toBe(200)
    }
    const rows = await h.gw.ledger.db.select().from(schema.vouchers)
    expect(rows.filter((r) => r.verdict === 'signed')).toHaveLength(80)
  })

  it('anchors the ledger onchain and every batch verifies against its memo', async () => {
    const res = await h.admin('POST', '/v1/anchor')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.anchored.length).toBeGreaterThan(0)
    const batches = await h.admin('GET', '/v1/batches')
    for (const b of batches.json) {
      expect(b.status).toBe('anchored')
      const v = await h.admin('POST', `/v1/batches/${b.id}/verify`)
      expect(v.json, JSON.stringify(v.json)).toMatchObject({ match: true, onchainRoot: b.merkleRoot })
      // the dashboard's client-side check: recompute from the rows the API returns
      const detail = await h.admin('GET', `/v1/batches/${b.id}`)
      expect(merkleRoot(detail.json.rows)).toBe(b.merkleRoot)
    }
    const all = await h.gw.ledger.db.select().from(schema.vouchers)
    expect(all.every((r) => r.batchId !== null)).toBe(true)
  })

  it('detects a ledger row edited after anchoring', async () => {
    const [b] = await h.gw.ledger.db.select().from(schema.batches).limit(1)
    const [row] = await h.gw.ledger.db
      .select()
      .from(schema.vouchers)
      .where(eq(schema.vouchers.batchId, b!.id))
      .limit(1)
    await h.gw.ledger.db
      .update(schema.vouchers)
      .set({ delta: row!.delta + 1 })
      .where(eq(schema.vouchers.id, row!.id))
    const v = await h.admin('POST', `/v1/batches/${b!.id}/verify`)
    expect(v.json.match).toBe(false)
    expect(v.json.reason).toMatch(/changed/)
    await h.gw.ledger.db
      .update(schema.vouchers)
      .set({ delta: row!.delta })
      .where(eq(schema.vouchers.id, row!.id))
    expect((await h.admin('POST', `/v1/batches/${b!.id}/verify`)).json.match).toBe(true)
  })

  it('reconciles every closed channel MATCHED against the chain', async () => {
    const r = await h.admin('GET', '/v1/reconcile')
    expect(r.json).toHaveLength(2)
    for (const row of r.json)
      expect(row, JSON.stringify(row)).toMatchObject({ status: 'MATCHED', refunded: true })
    expect(
      r.json.every((row: { ledgerSigned: string; settled: string }) => row.ledgerSigned === row.settled),
    ).toBe(true)
  })

  it('scores vendors from the run’s own data, including waste and a cheaper-option hint', async () => {
    const s = await h.admin('GET', '/v1/scores')
    const a = s.json.find((x: { vendorId: string }) => x.vendorId === 'inference-a')
    const b = s.json.find((x: { vendorId: string }) => x.vendorId === 'inference-b')
    expect(a.completedTasks).toBe(4)
    expect(b.completedTasks).toBe(4)
    expect(b.costPerCompletedTask).toBeGreaterThan(a.costPerCompletedTask)
    expect(b.cheaperOption).toMatchObject({ vendorId: 'inference-a' })
    expect(b.wastePct).toBeGreaterThan(0)
  })

  it('exports every voucher as CSV with batch transaction links', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/v1/export.csv?token=${h.adminToken}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    const lines = res.body.trim().split('\n')
    expect(lines[0]).toMatch(/^voucher_id,timestamp_utc,agent,department,task_id/)
    expect(lines.length - 1).toBe((await h.gw.ledger.db.select().from(schema.vouchers)).length)
    expect(lines[1]).toMatch(/explorer\.solana\.com\/tx\//)
  })

  it('serves an overview for the dashboard', async () => {
    const o = await h.admin('GET', '/v1/overview')
    expect(o.json).toMatchObject({ openChannels: 0, escrowTiedUp: 0, cluster: 'sandbox' })
    expect(o.json.spendToday).toBeGreaterThan(0)
  })
})
