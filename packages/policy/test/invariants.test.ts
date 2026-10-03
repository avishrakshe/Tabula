/**
 * Property-based invariants (fast-check). For any sequence of voucher requests, kills and time steps
 * under any policy, driving the engine the way the gateway does (sign only on `allow`):
 *
 *  1. no signed cumulative ever exceeds the channel deposit or the agent's onchain ceiling;
 *  2. no voucher is signed after the agent is killed or the global kill switch is on;
 *  3. the ledger total equals the sum of signed deltas (and the channel's signed cumulative);
 *  4. budgets and velocity windows are never exceeded by signed spend;
 *  5. every block is "first violating voucher": signing it would have crossed the stated limit.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { evaluate, type PolicyState, type SpendEvent } from '../src/evaluate.js'
import { compilePolicy, type Policy, type PolicyDoc } from '../src/policy.js'
import { T0 } from './helpers.js'

type Op =
  | { kind: 'pay'; units: number; unitPrice: number; task: number; vendor: number; dtMs: number }
  | { kind: 'kill' }
  | { kind: 'globalKill' }
  | { kind: 'wait'; dtMs: number }

const VENDORS = ['inference-a', 'inference-b', 'shady']

const policyDoc: fc.Arbitrary<PolicyDoc> = fc.record(
  {
    dailyBudgetUsd: fc.double({ min: 0, max: 5, noNaN: true }),
    perTaskBudgetUsd: fc.double({ min: 0, max: 2, noNaN: true }),
    velocity: fc.array(
      fc.record({
        windowSec: fc.integer({ min: 1, max: 120 }),
        maxUsd: fc.double({ min: 0, max: 1, noNaN: true }),
      }),
      { maxLength: 3 },
    ),
    maxUnitPriceUsd: fc.double({ min: 0, max: 0.01, noNaN: true }),
    vendors: fc.record({
      allow: fc.subarray(VENDORS),
      deny: fc.subarray(VENDORS, { maxLength: 1 }),
    }),
    anomaly: fc.record({
      zScore: fc.double({ min: 0.5, max: 6, noNaN: true }),
      minSamples: fc.integer({ min: 1, max: 8 }),
      bucketSec: fc.integer({ min: 1, max: 10 }),
    }),
    onViolation: fc.constantFrom('block' as const, 'pause' as const, 'kill_and_close' as const),
  },
  { requiredKeys: [] },
)

const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 20,
    arbitrary: fc.record({
      kind: fc.constant('pay' as const),
      units: fc.integer({ min: 1, max: 50 }),
      unitPrice: fc.integer({ min: 1, max: 5_000 }),
      task: fc.integer({ min: 0, max: 2 }),
      vendor: fc.integer({ min: 0, max: 2 }),
      dtMs: fc.integer({ min: 0, max: 5_000 }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'kill' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'globalKill' as const }) },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant('wait' as const), dtMs: fc.integer({ min: 0, max: 90_000 }) }),
  },
)

interface LedgerRow {
  readonly cumulative: bigint
  readonly delta: bigint
  readonly verdict: 'signed' | 'blocked'
}

function run(policy: Policy, deposit: bigint, ceiling: bigint | null, ops: readonly Op[]) {
  let now = T0
  let history: SpendEvent[] = []
  let signedCumulative = 0n
  let agentStatus: PolicyState['agentStatus'] = 'active'
  let globalKill = false
  let stoppedAt = -1
  const ledger: LedgerRow[] = []
  const signedAfterStop: number[] = []

  ops.forEach((o, i) => {
    if (o.kind === 'wait') {
      now += o.dtMs
      return
    }
    if (o.kind === 'kill') {
      agentStatus = 'killed'
      if (stoppedAt < 0) stoppedAt = i
      return
    }
    if (o.kind === 'globalKill') {
      globalKill = true
      if (stoppedAt < 0) stoppedAt = i
      return
    }
    now += o.dtMs
    const vendorId = VENDORS[o.vendor]!
    const taskId = `task-${o.task}`
    const s: PolicyState = {
      now,
      globalKill,
      agentStatus,
      history,
      channel: { deposit, signedCumulative },
      ceiling,
    }
    const d = evaluate(
      s,
      { agentId: 'a', taskId, vendorId, units: o.units, unitPrice: BigInt(o.unitPrice) },
      policy,
    )
    if (d.verdict === 'allow') {
      if (stoppedAt >= 0) signedAfterStop.push(i)
      signedCumulative = d.newCumulative
      history = [...history, { ts: now, amount: d.delta, taskId, vendorId }]
      ledger.push({ cumulative: d.newCumulative, delta: d.delta, verdict: 'signed' })
      // (4) signed spend stays inside every limit at the moment of signing
      const sum = (pred: (e: SpendEvent) => boolean) =>
        history.filter(pred).reduce((a, e) => a + e.amount, 0n)
      if (policy.perTaskBudget !== null)
        expect(sum((e) => e.taskId === taskId)).toBeLessThanOrEqual(policy.perTaskBudget)
      if (policy.dailyBudget !== null) {
        const day = Math.floor(now / 86_400_000) * 86_400_000
        expect(sum((e) => e.ts >= day)).toBeLessThanOrEqual(policy.dailyBudget)
      }
      for (const v of policy.velocity) expect(sum((e) => e.ts > now - v.windowMs)).toBeLessThanOrEqual(v.max)
    } else {
      ledger.push({ cumulative: d.newCumulative, delta: d.delta, verdict: 'blocked' })
      // (5) a limit-based block means signing would have crossed that limit
      if (
        d.rule &&
        [
          'CHANNEL_DEPOSIT',
          'ONCHAIN_CEILING',
          'TASK_BUDGET',
          'DAILY_BUDGET',
          'VELOCITY',
          'UNIT_PRICE',
        ].includes(d.rule)
      ) {
        expect(d.detail!.observed).toBeGreaterThan(d.detail!.limit)
      }
      if (d.action === 'kill_and_close') {
        agentStatus = 'killed'
        if (stoppedAt < 0) stoppedAt = i
      } else if (d.action === 'pause' && agentStatus === 'active') {
        agentStatus = 'paused'
        if (stoppedAt < 0) stoppedAt = i
      }
    }
    // (1) hard caps hold after every step
    expect(signedCumulative).toBeLessThanOrEqual(deposit)
    if (ceiling !== null) expect(signedCumulative).toBeLessThanOrEqual(ceiling)
  })
  return { ledger, signedCumulative, signedAfterStop }
}

const params = fc.record({
  doc: policyDoc,
  deposit: fc.bigInt({ min: 0n, max: 2_000_000n }),
  ceiling: fc.option(fc.bigInt({ min: 0n, max: 2_000_000n }), { nil: null }),
  ops: fc.array(op, { maxLength: 120 }),
})

describe('policy invariants (fast-check)', () => {
  it('signed cumulative never exceeds the deposit or the onchain ceiling', () => {
    fc.assert(
      fc.property(params, ({ doc, deposit, ceiling, ops }) => {
        run(compilePolicy(doc), deposit, ceiling, ops)
      }),
      { numRuns: 400 },
    )
  })

  it('no voucher is ever signed after a kill (agent, global, or rule-triggered)', () => {
    fc.assert(
      fc.property(params, ({ doc, deposit, ceiling, ops }) => {
        const { signedAfterStop } = run(compilePolicy(doc), deposit, ceiling, ops)
        expect(signedAfterStop).toEqual([])
      }),
      { numRuns: 400 },
    )
  })

  it('ledger total equals the sum of signed deltas and the signed cumulative', () => {
    fc.assert(
      fc.property(params, ({ doc, deposit, ceiling, ops }) => {
        const { ledger, signedCumulative } = run(compilePolicy(doc), deposit, ceiling, ops)
        const signed = ledger.filter((r) => r.verdict === 'signed')
        const total = signed.reduce((a, r) => a + r.delta, 0n)
        expect(total).toBe(signedCumulative)
        // cumulatives are strictly increasing across signed rows
        for (let i = 1; i < signed.length; i++)
          expect(signed[i]!.cumulative).toBeGreaterThan(signed[i - 1]!.cumulative)
      }),
      { numRuns: 400 },
    )
  })

  it('a killed agent stays refused for any request', () => {
    fc.assert(
      fc.property(params, fc.integer({ min: 1, max: 1000 }), ({ doc, deposit, ceiling }, units) => {
        const s: PolicyState = {
          now: T0,
          globalKill: false,
          agentStatus: 'killed',
          history: [],
          channel: { deposit, signedCumulative: 0n },
          ceiling,
        }
        const d = evaluate(
          s,
          { agentId: 'a', taskId: 't', vendorId: 'inference-a', units, unitPrice: 1n },
          compilePolicy(doc),
        )
        expect(d.verdict).toBe('block')
      }),
    )
  })
})
