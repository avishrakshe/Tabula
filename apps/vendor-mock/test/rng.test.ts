import { describe, expect, it } from 'vitest'
import { DEMO_VENDORS, demoVendor, pricePerCall } from '../src/config.js'
import { hashSeed, mulberry32 } from '../src/rng.js'

describe('seeded vendor behaviour', () => {
  it('mulberry32 is deterministic per seed', () => {
    const a = mulberry32(202)
    const b = mulberry32(202)
    const c = mulberry32(203)
    const xs = Array.from({ length: 5 }, () => a())
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs)
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(xs)
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
  })

  it('inference-b wastes roughly its configured share of paid calls', () => {
    const v = demoVendor('inference-b')
    const rand = mulberry32(v.seed)
    let waste = 0
    const n = 10_000
    for (let i = 0; i < n; i++) {
      const r = rand()
      rand() // latency draw, same order as the server
      if (r < v.errorRate + v.emptyRate + v.timeoutRate) waste++
    }
    expect(waste / n).toBeGreaterThan(0.12)
    expect(waste / n).toBeLessThan(0.16)
  })

  it('prices are per call and the mirror shares inference-a’s price but not its payee', () => {
    expect(pricePerCall(demoVendor('inference-a'))).toBe(1000n)
    expect(pricePerCall(demoVendor('inference-b'))).toBe(1250n)
    expect(demoVendor('mirror').payeeKey).not.toBe(demoVendor('inference-a').payeeKey)
    expect(new Set(DEMO_VENDORS.map((v) => v.port)).size).toBe(DEMO_VENDORS.length)
    expect(() => demoVendor('nope')).toThrow(/unknown demo vendor/)
    expect(hashSeed('a')).not.toBe(hashSeed('b'))
  })
})
