/**
 * Vendor scorecards: what each vendor actually delivers per dollar, computed from ledger rows.
 *
 * - waste       = signed spend on calls that errored, timed out or came back empty
 * - cost per completed task = all signed spend with the vendor for a task type / tasks of that
 *                 type that completed using it (failed tasks' spend still counts as cost)
 * - p95 latency = nearest-rank 95th percentile over paid calls with a recorded latency
 */
export interface ScoreVoucher {
  readonly vendorId: string
  readonly taskId: string
  readonly verdict: string
  readonly delta: number
  readonly responseStatus: string | null
  readonly latencyMs: number | null
}

export interface ScoreTask {
  readonly id: string
  readonly taskType: string
  readonly status: string
}

export interface VendorScore {
  readonly vendorId: string
  readonly taskType: string
  readonly spend: number
  readonly wasted: number
  /** 0..100, one decimal. */
  readonly wastePct: number
  readonly paidCalls: number
  readonly failedCalls: number
  readonly completedTasks: number
  readonly costPerCompletedTask: number | null
  readonly p95LatencyMs: number | null
  readonly cheaperOption: CheaperOption | null
}

export interface CheaperOption {
  readonly vendorId: string
  readonly costPerCompletedTask: number
  /** 0..100, whole percent. */
  readonly savingsPct: number
}

const WASTE = new Set(['error', 'timeout', 'empty'])

export function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!
}

export function vendorScores(
  vouchers: readonly ScoreVoucher[],
  tasks: readonly ScoreTask[],
  opts: { readonly minCompletedForHint?: number; readonly minSavingsPct?: number } = {},
): VendorScore[] {
  const minCompleted = opts.minCompletedForHint ?? 3
  const minSavings = opts.minSavingsPct ?? 5
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  interface Acc {
    vendorId: string
    taskType: string
    spend: number
    wasted: number
    paidCalls: number
    failedCalls: number
    completed: Set<string>
    latencies: number[]
  }
  const accs = new Map<string, Acc>()
  for (const v of vouchers) {
    if (v.verdict !== 'signed') continue
    const task = taskById.get(v.taskId)
    const taskType = task?.taskType ?? 'unknown'
    const key = `${v.vendorId}\u0000${taskType}`
    let a = accs.get(key)
    if (!a) {
      a = {
        vendorId: v.vendorId,
        taskType,
        spend: 0,
        wasted: 0,
        paidCalls: 0,
        failedCalls: 0,
        completed: new Set(),
        latencies: [],
      }
      accs.set(key, a)
    }
    a.spend += v.delta
    a.paidCalls++
    if (v.responseStatus !== null && WASTE.has(v.responseStatus)) {
      a.wasted += v.delta
      a.failedCalls++
    }
    if (v.latencyMs !== null) a.latencies.push(v.latencyMs)
    if (task?.status === 'completed') a.completed.add(task.id)
  }

  const base = [...accs.values()].map((a) => ({
    vendorId: a.vendorId,
    taskType: a.taskType,
    spend: a.spend,
    wasted: a.wasted,
    wastePct: a.spend === 0 ? 0 : Math.round((a.wasted / a.spend) * 1000) / 10,
    paidCalls: a.paidCalls,
    failedCalls: a.failedCalls,
    completedTasks: a.completed.size,
    costPerCompletedTask: a.completed.size === 0 ? null : Math.round(a.spend / a.completed.size),
    p95LatencyMs: p95(a.latencies),
  }))

  return base
    .map((s) => {
      let best: (typeof base)[number] | null = null
      for (const o of base) {
        if (o.taskType !== s.taskType || o.vendorId === s.vendorId) continue
        if (o.costPerCompletedTask === null || o.completedTasks < minCompleted) continue
        if (best === null || o.costPerCompletedTask < best.costPerCompletedTask!) best = o
      }
      let cheaperOption: CheaperOption | null = null
      if (best !== null && s.costPerCompletedTask !== null && s.costPerCompletedTask > 0) {
        const savingsPct = Math.round((1 - best.costPerCompletedTask! / s.costPerCompletedTask) * 100)
        if (savingsPct >= minSavings) {
          cheaperOption = {
            vendorId: best.vendorId,
            costPerCompletedTask: best.costPerCompletedTask!,
            savingsPct,
          }
        }
      }
      return { ...s, cheaperOption }
    })
    .sort((a, b) =>
      a.taskType === b.taskType ? a.vendorId.localeCompare(b.vendorId) : a.taskType.localeCompare(b.taskType),
    )
}
