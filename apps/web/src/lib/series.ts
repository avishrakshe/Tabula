import type { Series } from '@/components/charts/LineChart'
import type { VoucherRow } from './types'

export const SERIES_COLORS = ['var(--tb-series-1)', 'var(--tb-series-2)', 'var(--tb-series-3)']

/** Stable color per agent id (by registration order), never by rank. */
export function colorFor(agentIds: string[], id: string): string {
  const i = agentIds.indexOf(id)
  return SERIES_COLORS[i >= 0 ? i % SERIES_COLORS.length : 0]!
}

/** Cumulative signed spend per agent over time, sampled on a shared grid. */
export function cumulativeSpend(
  vouchers: VoucherRow[],
  agentIds: string[],
  labels: Record<string, string>,
  steps = 60,
): Series[] {
  const signed = vouchers.filter((v) => v.verdict === 'signed').sort((a, b) => a.ts - b.ts)
  if (signed.length === 0) return []
  const t0 = signed[0]!.ts
  const t1 = signed[signed.length - 1]!.ts
  const span = Math.max(1, t1 - t0)
  const grid = Array.from({ length: steps + 1 }, (_, i) => t0 + (span * i) / steps)
  return agentIds.map((id) => {
    const mine = signed.filter((v) => v.agentId === id)
    let acc = 0
    let j = 0
    const points = grid.map((x) => {
      while (j < mine.length && mine[j]!.ts <= x) acc += mine[j++]!.delta
      return { x, y: acc }
    })
    return { id, label: labels[id] ?? id, color: colorFor(agentIds, id), points }
  })
}

/** Signed spend in the trailing window at each step: exactly what the velocity rule measures. */
export function rollingSpend(
  vouchers: VoucherRow[],
  agentId: string,
  windowMs = 60_000,
  steps = 90,
): { x: number; y: number }[] {
  const mine = vouchers
    .filter((v) => v.agentId === agentId && v.verdict === 'signed')
    .sort((a, b) => a.ts - b.ts)
  if (mine.length === 0) return []
  const t0 = mine[0]!.ts - 5_000
  const t1 = mine[mine.length - 1]!.ts + 5_000
  const out: { x: number; y: number }[] = []
  for (let i = 0; i <= steps; i++) {
    const x = t0 + ((t1 - t0) * i) / steps
    let y = 0
    for (const v of mine) if (v.ts > x - windowMs && v.ts <= x) y += v.delta
    out.push({ x, y })
  }
  return out
}
