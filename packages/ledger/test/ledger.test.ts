import { eq } from 'drizzle-orm'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { canonicalize, canonicalVoucher } from '../src/canonical.js'
import { openLedger } from '../src/db.js'
import { formatBatchMemo, parseBatchMemo } from '../src/memo.js'
import { buildLevels, fromHex, hashLeaf, merkleProof, merkleRoot, toHex, verifyProof } from '../src/merkle.js'
import { reconcileChannel } from '../src/reconcile.js'
import { vouchers } from '../src/schema.js'
import { p95, vendorScores } from '../src/scores.js'

describe('canonicalize', () => {
  it('sorts keys at every level, drops undefined, renders bigints as strings', () => {
    expect(
      canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined }, e: 10n, f: null, g: true }),
    ).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1,"e":"10","f":null,"g":true}')
  })

  it('is independent of key insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.string(), fc.boolean())), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse())
        expect(canonicalize(reversed)).toBe(canonicalize(obj))
      }),
    )
  })

  it('rejects values JSON cannot represent faithfully', () => {
    expect(() => canonicalize(Number.NaN)).toThrow()
    expect(() => canonicalize(() => 1)).toThrow()
    expect(() => canonicalize(Symbol('x'))).toThrow()
  })

  it('canonicalVoucher keeps exactly the committed fields', () => {
    const row = {
      id: 1,
      channelId: 'c',
      agentId: 'a',
      taskId: 't',
      vendorId: 'v',
      cumulativeAmount: 5,
      delta: 5,
      unitCount: 1,
      unitPrice: 5,
      verdict: 'signed',
      ruleTriggered: null,
      signature: 'sig',
      responseStatus: 'ok',
      latencyMs: 12,
      ts: 99,
      batchId: 7,
      idempotencyKey: 'x',
      reason: 'r',
    }
    const c = canonicalVoucher(row)
    expect(Object.keys(c).sort()).toEqual([
      'agentId',
      'channelId',
      'cumulativeAmount',
      'delta',
      'id',
      'latencyMs',
      'responseStatus',
      'ruleTriggered',
      'signature',
      'taskId',
      'ts',
      'unitCount',
      'unitPrice',
      'vendorId',
      'verdict',
    ])
  })
})

describe('merkle', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, delta: i * 10 }))

  it('a single row is its own root (the leaf hash)', () => {
    expect(merkleRoot(rows(1))).toBe(toHex(hashLeaf(rows(1)[0])))
  })

  it('refuses an empty tree and bad hex', () => {
    expect(() => merkleRoot([])).toThrow()
    expect(() => buildLevels([])).toThrow()
    expect(() => fromHex('zz')).toThrow()
    expect(() => merkleProof(rows(3), 3)).toThrow(RangeError)
    expect(() => merkleProof(rows(3), -1)).toThrow(RangeError)
  })

  it('every leaf has a proof that verifies, for any tree size (odd sizes carry nodes up)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 70 }), (n) => {
        const rs = rows(n)
        const root = merkleRoot(rs)
        expect(root).toMatch(/^[0-9a-f]{64}$/)
        for (let i = 0; i < n; i++)
          expect(verifyProof(rs[i], merkleProof(rs, i), root.toUpperCase())).toBe(true)
      }),
      { numRuns: 40 },
    )
  })

  it('changing any row changes the root, and a proof does not verify a tampered row', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.nat(), (n, k) => {
        const rs = rows(n)
        const i = k % n
        const tampered = rs.map((r, j) => (j === i ? { ...r, delta: r.delta + 1 } : r))
        expect(merkleRoot(tampered)).not.toBe(merkleRoot(rs))
        expect(verifyProof(tampered[i], merkleProof(rs, i), merkleRoot(rs))).toBe(false)
      }),
      { numRuns: 60 },
    )
  })

  it('hex round-trips', () => {
    expect(toHex(fromHex('00ff10ab'))).toBe('00ff10ab')
  })
})

describe('batch memo', () => {
  const root = 'ab'.repeat(32)

  it('round-trips and tolerates explorer length prefixes', () => {
    const m = { batchId: 3, count: 25, firstVoucherId: 51, lastVoucherId: 75, root }
    const text = formatBatchMemo(m)
    expect(text).toBe(`tabula:v1 batch=3 n=25 first=51 last=75 root=${root}`)
    expect(text.length).toBeLessThan(120)
    expect(parseBatchMemo(text)).toEqual(m)
    expect(parseBatchMemo(`[${text.length}] ${text}`)).toEqual(m)
  })

  it('rejects malformed memos and roots', () => {
    expect(parseBatchMemo('hello')).toBeNull()
    expect(() =>
      formatBatchMemo({ batchId: 1, count: 1, firstVoucherId: 1, lastVoucherId: 1, root: 'XYZ' }),
    ).toThrow()
  })
})

describe('reconcileChannel', () => {
  it.each([
    [{ ledgerSigned: 100n, deposit: 500n, settled: 100n, refunded: true }, 'MATCHED', 0n],
    [{ ledgerSigned: 500n, deposit: 500n, settled: 500n, refunded: false }, 'MATCHED', 0n],
    [{ ledgerSigned: 100n, deposit: 500n, settled: 100n, refunded: false }, 'REFUND_PENDING', 0n],
    [{ ledgerSigned: 100n, deposit: 500n, settled: 60n, refunded: false }, 'LEDGER_AHEAD', -40n],
    [{ ledgerSigned: 100n, deposit: 500n, settled: 130n, refunded: true }, 'CHAIN_AHEAD', 30n],
  ] as const)('case %# -> %s', (input, status, difference) => {
    const r = reconcileChannel(input)
    expect(r.status).toBe(status)
    expect(r.difference).toBe(difference)
    expect(r.refundDue).toBe(input.deposit - input.settled)
    expect(r.explanation.length).toBeGreaterThan(10)
  })
})

describe('vendorScores', () => {
  it('computes waste, cost per completed task, p95 and a cheaper-option hint', () => {
    const tasks = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, taskType: 'summarize', status: 'completed' })),
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `b${i}`,
        taskType: 'summarize',
        status: i < 9 ? 'completed' : 'failed',
      })),
    ]
    const v = []
    // vendor-a: 10 tasks x 10 calls x 690 micros, all ok
    for (let t = 0; t < 10; t++) {
      for (let c = 0; c < 10; c++) {
        v.push({
          vendorId: 'vendor-a',
          taskId: `a${t}`,
          verdict: 'signed',
          delta: 690,
          responseStatus: 'ok',
          latencyMs: 100 + c,
        })
      }
    }
    // vendor-b: 10 tasks x 10 calls x 1000 micros, 14 of 100 calls wasted
    for (let t = 0; t < 10; t++) {
      for (let c = 0; c < 10; c++) {
        const bad = t * 10 + c < 14
        v.push({
          vendorId: 'vendor-b',
          taskId: `b${t}`,
          verdict: 'signed',
          delta: 1000,
          responseStatus: bad ? (c % 2 ? 'error' : 'empty') : 'ok',
          latencyMs: bad ? null : 300,
        })
      }
    }
    v.push({
      vendorId: 'vendor-b',
      taskId: 'b0',
      verdict: 'blocked',
      delta: 5000,
      responseStatus: null,
      latencyMs: null,
    })
    const scores = vendorScores(v, tasks)
    const a = scores.find((s) => s.vendorId === 'vendor-a')!
    const b = scores.find((s) => s.vendorId === 'vendor-b')!
    expect(a).toMatchObject({
      spend: 69_000,
      wasted: 0,
      wastePct: 0,
      completedTasks: 10,
      costPerCompletedTask: 6_900,
      p95LatencyMs: 109,
      cheaperOption: null,
    })
    expect(b).toMatchObject({
      spend: 100_000,
      wasted: 14_000,
      wastePct: 14,
      paidCalls: 100,
      failedCalls: 14,
      completedTasks: 9,
      p95LatencyMs: 300,
    })
    expect(b.costPerCompletedTask).toBe(11_111)
    expect(b.cheaperOption).toEqual({ vendorId: 'vendor-a', costPerCompletedTask: 6_900, savingsPct: 38 })
  })

  it('needs enough completed tasks and a meaningful saving before hinting', () => {
    const tasks = [
      { id: 'x', taskType: 'code', status: 'completed' },
      { id: 'y', taskType: 'code', status: 'completed' },
    ]
    const v = [
      { vendorId: 'p', taskId: 'x', verdict: 'signed', delta: 100, responseStatus: 'ok', latencyMs: 1 },
      { vendorId: 'q', taskId: 'y', verdict: 'signed', delta: 102, responseStatus: 'timeout', latencyMs: 5 },
      { vendorId: 'q', taskId: 'orphan', verdict: 'signed', delta: 0, responseStatus: null, latencyMs: null },
    ]
    expect(vendorScores(v, tasks).every((s) => s.cheaperOption === null)).toBe(true)
    const hinted = vendorScores(v, tasks, { minCompletedForHint: 1, minSavingsPct: 1 })
    expect(hinted.find((s) => s.vendorId === 'q' && s.taskType === 'code')?.cheaperOption?.vendorId).toBe('p')
    const unknown = hinted.find((s) => s.taskType === 'unknown')!
    expect(unknown).toMatchObject({ spend: 0, wastePct: 0, costPerCompletedTask: null, p95LatencyMs: null })
  })

  it('p95 uses nearest rank', () => {
    expect(p95([])).toBeNull()
    expect(p95([5])).toBe(5)
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95)
  })
})

describe('openLedger (node:sqlite + drizzle)', () => {
  it('migrates, writes, reads back and enforces voucher idempotency', async () => {
    const ledger = await openLedger(':memory:')
    const row = {
      idempotencyKey: 'sess-1:1000',
      channelId: 'sess-1',
      agentId: 'research-01',
      taskId: 't1',
      vendorId: 'inference-a',
      cumulativeAmount: 1000,
      delta: 1000,
      unitCount: 10,
      unitPrice: 100,
      verdict: 'signed' as const,
      signature: 'abc',
      ts: 1,
    }
    await ledger.db.insert(vouchers).values(row)
    await expect(ledger.db.insert(vouchers).values(row)).rejects.toThrow()
    const dup = await ledger.db.insert(vouchers).values(row).onConflictDoNothing().returning()
    expect(dup).toHaveLength(0)
    const got = await ledger.db.select().from(vouchers).where(eq(vouchers.channelId, 'sess-1'))
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ id: 1, verdict: 'signed', cumulativeAmount: 1000, batchId: null })
    const one = await ledger.db.select().from(vouchers).where(eq(vouchers.id, 1)).get()
    expect(one?.signature).toBe('abc')
    const none = await ledger.db.select().from(vouchers).where(eq(vouchers.id, 99)).get()
    expect(none).toBeUndefined()
    ledger.close()
  })

  it('reopens an existing file without re-running migrations and keeps rows', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const file = join(mkdtempSync(join(tmpdir(), 'tabula-ledger-')), 'sub', 'ledger.sqlite')
    const a = await openLedger(file)
    await a.db.insert(vouchers).values({
      idempotencyKey: 'k',
      channelId: 'c',
      agentId: 'a',
      taskId: 't',
      vendorId: 'v',
      cumulativeAmount: 1,
      delta: 1,
      unitCount: 1,
      unitPrice: 1,
      verdict: 'blocked',
      ts: 1,
    })
    a.close()
    const b = await openLedger(file)
    expect(await b.db.select().from(vouchers)).toHaveLength(1)
    b.close()
  })
})
