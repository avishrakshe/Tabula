import { describe, expect, it } from 'vitest'
import { describeDecision } from '../src/describe.js'
import { anomalyStats, evaluate, pruneHistory, recordSpend, utcDayStart } from '../src/evaluate.js'
import { compilePolicy, EMPTY_POLICY } from '../src/policy.js'
import { req, spend, state, T0 } from './helpers.js'

const policy = compilePolicy({
  agent: 'research-01',
  dailyBudgetUsd: 25,
  perTaskBudgetUsd: 5,
  velocity: { windowSec: 60, maxUsd: 0.5 },
  maxUnitPriceUsd: 0.0004,
  vendors: { allow: ['inference-a', 'inference-b'], deny: ['shady'] },
  onViolation: 'kill_and_close',
})

describe('evaluate — allow path', () => {
  it('allows a voucher within every limit and reports headroom', () => {
    const d = evaluate(state(), req(), policy)
    expect(d.verdict).toBe('allow')
    expect(d.delta).toBe(1_000n)
    expect(d.newCumulative).toBe(1_000n)
    expect(d.rule).toBeUndefined()
    expect(d.remaining).toEqual({
      task: 5_000_000n,
      daily: 25_000_000n,
      velocity: 500_000n,
      channel: 10_000_000n,
      ceiling: null,
    })
  })

  it('evaluates the delta but returns the cumulative that would be signed', () => {
    const d = evaluate(state({ channel: { deposit: 10_000_000n, signedCumulative: 42_000n } }), req(), policy)
    expect(d.delta).toBe(1_000n)
    expect(d.newCumulative).toBe(43_000n)
  })

  it('reports null headroom when no limit exists', () => {
    const d = evaluate(state({ ceiling: 5_000n }), req(), EMPTY_POLICY)
    expect(d.verdict).toBe('allow')
    expect(d.remaining).toEqual({
      task: null,
      daily: null,
      velocity: null,
      channel: 10_000_000n,
      ceiling: 5_000n,
    })
  })

  it('reports the tightest velocity headroom across windows', () => {
    const p = compilePolicy({
      velocity: [
        { windowSec: 3600, maxUsd: 1 },
        { windowSec: 10, maxUsd: 0.01 },
        { windowSec: 60, maxUsd: 0.1 },
      ],
    })
    const d = evaluate(state({ history: [spend(T0 - 5_000, 4_000n)] }), req(), p)
    expect(d.remaining.velocity).toBe(6_000n)
  })

  it('is pure: identical inputs give identical decisions', () => {
    const s = state({ history: [spend(T0 - 1000, 10n)] })
    expect(evaluate(s, req(), policy)).toEqual(evaluate(s, req(), policy))
  })
})

describe('evaluate — every rule', () => {
  it('rejects non-positive or non-integer units', () => {
    for (const units of [0, -1, 1.5, Number.NaN]) {
      const d = evaluate(state(), req({ units }), policy)
      expect(d.rule).toBe('INVALID_REQUEST')
      expect(d.action).toBe('block')
      expect(d.delta).toBe(0n)
    }
  })

  it('rejects zero or negative unit prices (a voucher must strictly increase)', () => {
    expect(evaluate(state(), req({ unitPrice: 0n }), policy).rule).toBe('INVALID_REQUEST')
    expect(evaluate(state(), req({ unitPrice: -5n }), policy).rule).toBe('INVALID_REQUEST')
  })

  it('global kill switch blocks everyone', () => {
    const d = evaluate(state({ globalKill: true }), req(), policy)
    expect(d).toMatchObject({ verdict: 'block', rule: 'GLOBAL_KILL', action: 'block' })
  })

  it('killed and paused agents are refused', () => {
    expect(evaluate(state({ agentStatus: 'killed' }), req(), policy).rule).toBe('AGENT_KILLED')
    expect(evaluate(state({ agentStatus: 'paused' }), req(), policy).rule).toBe('AGENT_PAUSED')
  })

  it('deny list wins over allow list; unknown vendors are refused', () => {
    expect(evaluate(state(), req({ vendorId: 'shady' }), policy)).toMatchObject({
      rule: 'VENDOR_DENIED',
      action: 'kill_and_close',
    })
    expect(evaluate(state(), req({ vendorId: 'faster-mirror' }), policy).rule).toBe('VENDOR_NOT_ALLOWED')
  })

  it('caps the price per unit', () => {
    const d = evaluate(state(), req({ unitPrice: 401n }), policy)
    expect(d).toMatchObject({ rule: 'UNIT_PRICE', detail: { limit: 400n, observed: 401n } })
    expect(evaluate(state(), req({ unitPrice: 400n }), policy).verdict).toBe('allow')
  })

  it('never signs above the channel deposit (needs a top-up, not a kill)', () => {
    const s = state({ channel: { deposit: 5_000n, signedCumulative: 4_500n } })
    const d = evaluate(s, req(), policy)
    expect(d).toMatchObject({
      rule: 'CHANNEL_DEPOSIT',
      action: 'block',
      detail: { limit: 5_000n, observed: 5_500n },
    })
    expect(evaluate(s, req({ units: 5 }), policy).verdict).toBe('allow')
  })

  it('never signs above the onchain ceiling', () => {
    const d = evaluate(state({ ceiling: 800n }), req(), policy)
    expect(d).toMatchObject({ rule: 'ONCHAIN_CEILING', action: 'block', remaining: { ceiling: 800n } })
  })

  it('task budget counts only this task, across channels', () => {
    const history = [spend(T0 - 3_600_000, 4_999_500n, 'task-1'), spend(T0 - 3_600_000, 3_000_000n, 'task-2')]
    const d = evaluate(state({ history }), req(), policy)
    expect(d).toMatchObject({ rule: 'TASK_BUDGET', action: 'block', remaining: { task: 500n } })
    expect(evaluate(state({ history }), req({ taskId: 'task-3' }), policy).verdict).toBe('allow')
  })

  it('daily budget counts the UTC day only', () => {
    const yesterday = utcDayStart(T0) - 1
    const p = compilePolicy({ dailyBudgetUsd: 1 })
    const big = [spend(yesterday, 900_000n), spend(T0 - 1000, 999_500n, 'other')]
    expect(evaluate(state({ history: big }), req(), p)).toMatchObject({
      rule: 'DAILY_BUDGET',
      detail: { limit: 1_000_000n, observed: 1_000_500n },
      remaining: { daily: 500n },
    })
    // an explicit budget-day start overrides UTC midnight
    expect(evaluate(state({ history: big, dayStartMs: T0 }), req(), p).verdict).toBe('allow')
  })

  it('velocity trips on the first voucher that would exceed the window', () => {
    // 0.499 spent in the last 60s; this 0.001 voucher reaches exactly 0.5 -> allowed
    const history = [spend(T0 - 59_999, 499_000n)]
    expect(evaluate(state({ history }), req(), policy).verdict).toBe('allow')
    // one micro more is the first violating voucher
    const d = evaluate(
      state({ history }),
      req({ units: 1, unitPrice: 1_001n }),
      compilePolicy({ velocity: { windowSec: 60, maxUsd: 0.5 } }),
    )
    expect(d).toMatchObject({
      rule: 'VELOCITY',
      action: 'kill_and_close',
      detail: { limit: 500_000n, observed: 500_001n, windowSec: 60 },
    })
    expect(d.reason).toBe('Stopped paying research-01: spent $0.500001 in 60s (limit $0.50)')
  })

  it('velocity forgets spend that left the window', () => {
    const history = [spend(T0 - 60_000, 499_500n)]
    expect(evaluate(state({ history }), req(), policy).verdict).toBe('allow')
  })

  it('ignores future-dated history', () => {
    const history = [spend(T0 + 1, 10_000_000n)]
    expect(evaluate(state({ history }), req(), policy).verdict).toBe('allow')
  })

  it('checks rules in a fixed order: kill before vendor before price before caps before budgets', () => {
    const everythingWrong = state({
      globalKill: true,
      agentStatus: 'killed',
      channel: { deposit: 0n, signedCumulative: 0n },
      ceiling: 0n,
    })
    const bad = req({ vendorId: 'shady', unitPrice: 10_000n })
    expect(evaluate(everythingWrong, bad, policy).rule).toBe('GLOBAL_KILL')
    expect(evaluate({ ...everythingWrong, globalKill: false }, bad, policy).rule).toBe('AGENT_KILLED')
    const active = { ...everythingWrong, globalKill: false, agentStatus: 'active' as const }
    expect(evaluate(active, bad, policy).rule).toBe('VENDOR_DENIED')
    expect(evaluate(active, { ...bad, vendorId: 'inference-a' }, policy).rule).toBe('UNIT_PRICE')
    expect(evaluate(active, req(), policy).rule).toBe('CHANNEL_DEPOSIT')
    expect(
      evaluate({ ...active, channel: { deposit: 10n ** 9n, signedCumulative: 0n } }, req(), policy).rule,
    ).toBe('ONCHAIN_CEILING')
  })
})

describe('anomaly', () => {
  const p = compilePolicy({ anomaly: { zScore: 4, minSamples: 6, bucketSec: 10 }, onViolation: 'pause' })
  // a steady agent: 1,000 micros in each of the previous 6 ten-second buckets
  const steady = Array.from({ length: 6 }, (_, i) => spend(T0 - 10_000 * (i + 1), 1_000n))

  it('does not judge an agent before it has a baseline', () => {
    expect(anomalyStats(steady.slice(0, 5), T0, { bucketMs: 10_000, minSamples: 6 }, 50_000n)).toBeNull()
    expect(evaluate(state({ history: steady.slice(0, 5) }), req({ units: 500 }), p).verdict).toBe('allow')
  })

  it('flags a spike far above the baseline', () => {
    const d = evaluate(state({ history: steady }), req({ units: 100, unitPrice: 100n }), p)
    expect(d).toMatchObject({ verdict: 'block', rule: 'ANOMALY', action: 'pause', detail: { windowSec: 10 } })
    expect(d.detail?.zScore).toBeGreaterThan(4)
    expect(d.detail?.baselineMean).toBe(1_000n)
    expect(d.reason).toMatch(
      /^Stopped paying research-01: spend jumped to \$0\.01 per 10s, \d+\.\dσ above its usual \$0\.001$/,
    )
  })

  it('tolerates normal jitter', () => {
    expect(evaluate(state({ history: steady }), req({ units: 15, unitPrice: 100n }), p).verdict).toBe('allow')
  })

  it('counts spend already in the current bucket and buckets on exact boundaries correctly', () => {
    const boundary = [...steady, spend(T0 - 5_000, 1_000n)]
    const s = anomalyStats(boundary, T0, { bucketMs: 10_000, minSamples: 6 }, 0n)
    expect(s?.current).toBe(1_000n)
    expect(s?.mean).toBe(1_000)
    // an event exactly one bucket old belongs to bucket 1, not the current bucket
    const s2 = anomalyStats(steady, T0, { bucketMs: 10_000, minSamples: 6 }, 0n)
    expect(s2?.current).toBe(0n)
    // events older than the baseline window are ignored
    const old = [...steady, spend(T0 - 70_000, 10n ** 9n)]
    expect(anomalyStats(old, T0, { bucketMs: 10_000, minSamples: 6 }, 0n)?.mean).toBe(1_000)
  })
})

describe('history reducers', () => {
  it('records spend immutably', () => {
    const h = [spend(T0, 1n)]
    const h2 = recordSpend(h, spend(T0 + 1, 2n))
    expect(h).toHaveLength(1)
    expect(h2).toHaveLength(2)
  })

  it('prunes to the longest window the policy looks at (at least a day)', () => {
    const h = [spend(T0 - 90_000_000, 1n), spend(T0 - 80_000_000, 1n), spend(T0, 1n)]
    expect(pruneHistory(h, T0, EMPTY_POLICY)).toHaveLength(2)
    const long = compilePolicy({ velocity: { windowSec: 100_000, maxUsd: 1 } })
    expect(pruneHistory(h, T0, long)).toHaveLength(3)
    const anomalous = compilePolicy({ anomaly: { zScore: 3, minSamples: 10_000, bucketSec: 10 } })
    expect(pruneHistory(h, T0, anomalous)).toHaveLength(3)
  })
})

describe('describeDecision', () => {
  const r = req({ vendorId: 'inference-b', taskId: 'summarize' })
  const base = {
    delta: 1_000n,
    remaining: { task: null, daily: null, velocity: null, channel: 0n, ceiling: null },
  }

  it.each([
    [
      'INVALID_REQUEST',
      { limit: 0n, observed: 0n, message: 'units must be a positive integer' },
      'Rejected a payment request from Ada: units must be a positive integer',
    ],
    ['INVALID_REQUEST', undefined, 'Rejected a payment request from Ada: invalid request'],
    [
      'GLOBAL_KILL',
      undefined,
      'Did not pay for Ada: all agent payments are stopped (global kill switch is on)',
    ],
    [
      'AGENT_KILLED',
      undefined,
      'Did not pay for Ada: this agent was stopped and no further payments are signed',
    ],
    ['AGENT_PAUSED', undefined, 'Did not pay for Ada: this agent is paused'],
    ['VENDOR_DENIED', undefined, 'Blocked Ada: inference-b is on the deny list'],
    ['VENDOR_NOT_ALLOWED', undefined, 'Blocked Ada: inference-b is not an approved vendor'],
    [
      'UNIT_PRICE',
      { limit: 400n, observed: 900n },
      'Blocked Ada: inference-b asked $0.0009 per unit (max $0.0004)',
    ],
    [
      'CHANNEL_DEPOSIT',
      { limit: 500_000n, observed: 0n },
      'Paused paying inference-b for Ada: the escrow is used up ($0.50 deposited); a top-up is needed',
    ],
    [
      'ONCHAIN_CEILING',
      { limit: 2_000_000n, observed: 0n },
      'Blocked Ada: this payment would pass its onchain allowance ($2.00 cap)',
    ],
    [
      'TASK_BUDGET',
      { limit: 5_000_000n, observed: 5_000_100n },
      "Stopped paying for Ada's task summarize: it would reach $5.0001 (task budget $5.00)",
    ],
    [
      'DAILY_BUDGET',
      { limit: 25_000_000n, observed: 25_500_000n },
      "Stopped paying Ada: today's spend would reach $25.50 (daily budget $25.00)",
    ],
    [
      'VELOCITY',
      { limit: 500_000n, observed: 620_000n, windowSec: 60 },
      'Stopped paying Ada: spent $0.62 in 60s (limit $0.50)',
    ],
    [
      'ANOMALY',
      { limit: 4000n, observed: 20_000n, windowSec: 10, zScore: 12.34, baselineMean: 1_000n },
      'Stopped paying Ada: spend jumped to $0.02 per 10s, 12.3σ above its usual $0.001',
    ],
    [
      'ANOMALY',
      { limit: 4000n, observed: 20_000n, windowSec: 10 },
      'Stopped paying Ada: spend jumped to $0.02 per 10s, 0.0σ above its usual $0.00',
    ],
    [undefined, undefined, 'Blocked a payment for Ada'],
  ] as const)('%s', (rule, detail, text) => {
    expect(describeDecision({ verdict: 'block', rule, detail, ...base }, r, 'Ada')).toBe(text)
  })

  it('describes allowed payments and defaults the name to the agent id', () => {
    expect(describeDecision({ verdict: 'allow', ...base }, r)).toBe('Paid inference-b $0.001 for research-01')
  })
})
