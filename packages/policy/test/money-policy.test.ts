import { describe, expect, it } from 'vitest'
import { formatUsd, usdToMicros } from '../src/money.js'
import { compilePolicy, EMPTY_POLICY, mergePolicies, PolicyValidationError } from '../src/policy.js'

describe('money', () => {
  it('converts USD to integer micros with rounding', () => {
    expect(usdToMicros(25)).toBe(25_000_000n)
    expect(usdToMicros(0.0004)).toBe(400n)
    expect(usdToMicros(0.1 + 0.2)).toBe(300_000n)
    expect(() => usdToMicros(Number.NaN)).toThrow(RangeError)
  })

  it('formats micros as dollars, keeping sub-cent precision only when present', () => {
    expect(formatUsd(620_000n)).toBe('$0.62')
    expect(formatUsd(25_000_000n)).toBe('$25.00')
    expect(formatUsd(400n)).toBe('$0.0004')
    expect(formatUsd(1_234_567n)).toBe('$1.234567')
    expect(formatUsd(-500_000n)).toBe('-$0.50')
    expect(formatUsd(0n)).toBe('$0.00')
  })
})

describe('compilePolicy', () => {
  it('compiles the PROMPT example', () => {
    const p = compilePolicy({
      agent: 'research-01',
      dailyBudgetUsd: 25,
      perTaskBudgetUsd: 5,
      velocity: { windowSec: 60, maxUsd: 0.5 },
      maxUnitPriceUsd: 0.0004,
      vendors: { allow: ['inference-mock'], deny: [] },
      anomaly: { zScore: 4, minSamples: 30 },
      onViolation: 'kill_and_close',
    })
    expect(p.dailyBudget).toBe(25_000_000n)
    expect(p.perTaskBudget).toBe(5_000_000n)
    expect(p.velocity).toEqual([{ windowMs: 60_000, max: 500_000n }])
    expect(p.maxUnitPrice).toBe(400n)
    expect([...(p.vendorAllow ?? [])]).toEqual(['inference-mock'])
    expect(p.vendorDeny.size).toBe(0)
    expect(p.anomaly).toEqual({ zScore: 4, minSamples: 30, bucketMs: 10_000 })
    expect(p.onViolation).toBe('kill_and_close')
  })

  it('defaults to no limits and kill_and_close', () => {
    const p = compilePolicy({})
    expect(p).toMatchObject({
      dailyBudget: null,
      perTaskBudget: null,
      velocity: [],
      maxUnitPrice: null,
      vendorAllow: null,
      anomaly: null,
      onViolation: 'kill_and_close',
    })
  })

  it('accepts several velocity windows and a custom anomaly bucket', () => {
    const p = compilePolicy({
      velocity: [
        { windowSec: 10, maxUsd: 0.1 },
        { windowSec: 3600, maxUsd: 5 },
      ],
      anomaly: { zScore: 3, minSamples: 5, bucketSec: 2 },
      onViolation: 'pause',
    })
    expect(p.velocity).toHaveLength(2)
    expect(p.anomaly?.bucketMs).toBe(2000)
    expect(p.onViolation).toBe('pause')
  })

  it.each([
    [{ dailyBudgetUsd: -1 }, 'dailyBudgetUsd'],
    [{ perTaskBudgetUsd: Number.POSITIVE_INFINITY }, 'perTaskBudgetUsd'],
    [{ velocity: { windowSec: 0, maxUsd: 1 } }, 'windowSec'],
    [{ velocity: { windowSec: 1.5, maxUsd: 1 } }, 'windowSec'],
    [{ velocity: { windowSec: 60, maxUsd: -0.01 } }, 'maxUsd'],
    [{ anomaly: { zScore: 0, minSamples: 3 } }, 'zScore'],
    [{ anomaly: { zScore: Number.NaN, minSamples: 3 } }, 'zScore'],
    [{ anomaly: { zScore: 3, minSamples: 0 } }, 'minSamples'],
    [{ onViolation: 'explode' as never }, 'onViolation'],
  ])('rejects invalid policy %j', (doc, field) => {
    expect(() => compilePolicy(doc)).toThrow(PolicyValidationError)
    expect(() => compilePolicy(doc)).toThrow(field)
  })
})

describe('mergePolicies', () => {
  const global = compilePolicy({
    dailyBudgetUsd: 100,
    velocity: { windowSec: 60, maxUsd: 2 },
    vendors: { allow: ['a', 'b', 'c'], deny: ['x'] },
    anomaly: { zScore: 5, minSamples: 30 },
    onViolation: 'pause',
  })
  const agent = compilePolicy({
    dailyBudgetUsd: 25,
    perTaskBudgetUsd: 5,
    velocity: { windowSec: 10, maxUsd: 0.5 },
    maxUnitPriceUsd: 0.001,
    vendors: { allow: ['b', 'c', 'd'], deny: ['y'] },
    anomaly: { zScore: 3, minSamples: 10 },
    onViolation: 'kill_and_close',
  })

  it('takes the strictest of every limit', () => {
    const m = mergePolicies(global, agent)
    expect(m.dailyBudget).toBe(25_000_000n)
    expect(m.perTaskBudget).toBe(5_000_000n)
    expect(m.maxUnitPrice).toBe(1_000n)
    expect(m.velocity).toHaveLength(2)
    expect([...(m.vendorAllow ?? [])].sort()).toEqual(['b', 'c'])
    expect([...m.vendorDeny].sort()).toEqual(['x', 'y'])
    expect(m.anomaly?.zScore).toBe(3)
    expect(m.onViolation).toBe('kill_and_close')
  })

  it('is order-independent for limits and keeps the stricter side either way', () => {
    const m = mergePolicies(agent, global)
    expect(m.dailyBudget).toBe(25_000_000n)
    expect(m.anomaly?.zScore).toBe(3)
    expect(m.onViolation).toBe('kill_and_close')
  })

  it('treats a missing allowlist or anomaly rule as "no constraint from this scope"', () => {
    const open = compilePolicy({ onViolation: 'block' })
    expect(mergePolicies(open, agent).vendorAllow).toEqual(agent.vendorAllow)
    expect(mergePolicies(agent, open).vendorAllow).toEqual(agent.vendorAllow)
    expect(mergePolicies(open, agent).anomaly).toEqual(agent.anomaly)
    expect(mergePolicies(agent, open).anomaly).toEqual(agent.anomaly)
    expect(mergePolicies(open).onViolation).toBe('block')
    expect(mergePolicies()).toEqual(EMPTY_POLICY)
  })
})
