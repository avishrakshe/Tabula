import { describeDecision } from './describe.js'
import type { Policy, ViolationAction } from './policy.js'

export type AgentStatus = 'active' | 'paused' | 'killed'

/** One signed voucher's worth of spend (the delta, not the cumulative). */
export interface SpendEvent {
  readonly ts: number
  readonly amount: bigint
  readonly taskId: string
  readonly vendorId: string
}

export interface ChannelSnapshot {
  /** Escrowed onchain. The program rejects any voucher above it, so it is a hard cap. */
  readonly deposit: bigint
  /** Highest cumulative Tabula has signed on this channel. */
  readonly signedCumulative: bigint
}

export interface PolicyState {
  /** Evaluation time, epoch ms. */
  readonly now: number
  readonly globalKill: boolean
  readonly agentStatus: AgentStatus
  /** This agent's signed spend across all channels and tasks. Events after `now` are ignored. */
  readonly history: readonly SpendEvent[]
  readonly channel: ChannelSnapshot
  /** Highest cumulative this channel may reach under the agent's onchain allowance; null = not tracked. */
  readonly ceiling: bigint | null
  /** Start of the budget day, epoch ms. Defaults to UTC midnight of `now`. */
  readonly dayStartMs?: number
}

export interface VoucherRequest {
  readonly agentId: string
  readonly taskId: string
  readonly vendorId: string
  readonly units: number
  /** Micro-dollars per unit. */
  readonly unitPrice: bigint
}

export type Rule =
  | 'INVALID_REQUEST'
  | 'GLOBAL_KILL'
  | 'AGENT_KILLED'
  | 'AGENT_PAUSED'
  | 'VENDOR_DENIED'
  | 'VENDOR_NOT_ALLOWED'
  | 'UNIT_PRICE'
  | 'CHANNEL_DEPOSIT'
  | 'ONCHAIN_CEILING'
  | 'TASK_BUDGET'
  | 'DAILY_BUDGET'
  | 'VELOCITY'
  | 'ANOMALY'

export interface Remaining {
  readonly task: bigint | null
  readonly daily: bigint | null
  /** Tightest headroom across velocity windows. */
  readonly velocity: bigint | null
  readonly channel: bigint
  readonly ceiling: bigint | null
}

export interface ViolationDetail {
  /** The limit that was hit, in micros (or the z-score threshold ×1000 for anomaly). */
  readonly limit: bigint
  /** What the spend would have been with this voucher, in micros. */
  readonly observed: bigint
  readonly windowSec?: number
  readonly zScore?: number
  readonly baselineMean?: bigint
  readonly message?: string
}

export interface Decision {
  readonly verdict: 'allow' | 'block'
  readonly rule?: Rule
  /** What the gateway should do: just refuse, or also pause / kill the agent and close its channels. */
  readonly action?: ViolationAction
  readonly detail?: ViolationDetail
  /** Plain-language explanation for humans and the agent. */
  readonly reason?: string
  readonly delta: bigint
  readonly newCumulative: bigint
  readonly remaining: Remaining
}

const DAY_MS = 86_400_000

export function utcDayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS
}

function sumWhere(history: readonly SpendEvent[], pred: (e: SpendEvent) => boolean): bigint {
  let total = 0n
  for (const e of history) if (pred(e)) total += e.amount
  return total
}

interface AnomalyStats {
  readonly z: number
  readonly current: bigint
  readonly mean: number
}

/**
 * Z-score of this agent's spend in the current bucket (including this voucher) against the
 * previous `minSamples` buckets. Skipped (null) until the baseline holds at least `minSamples`
 * signed vouchers, so a freshly started agent is not flagged. The standard deviation is floored
 * at 25% of the mean (and 1 micro) so a perfectly regular agent is not flagged for tiny jitter.
 */
export function anomalyStats(
  history: readonly SpendEvent[],
  now: number,
  rule: { readonly bucketMs: number; readonly minSamples: number },
  delta: bigint,
): AnomalyStats | null {
  const b = rule.bucketMs
  const n = rule.minSamples
  const baselineStart = now - b * (n + 1)
  const buckets = new Array<number>(n).fill(0)
  let current = delta
  let baselineEvents = 0
  for (const e of history) {
    if (e.ts > now || e.ts <= baselineStart) continue
    if (e.ts > now - b) {
      current += e.amount
      continue
    }
    // bucket i (1..n) covers (now - (i+1)b, now - i*b]  <=>  i = floor((now - ts) / b)
    const i = Math.floor((now - e.ts) / b)
    buckets[i - 1]! += Number(e.amount)
    baselineEvents++
  }
  if (baselineEvents < n) return null
  const mean = buckets.reduce((a, x) => a + x, 0) / n
  const variance = buckets.reduce((a, x) => a + (x - mean) ** 2, 0) / n
  const std = Math.max(Math.sqrt(variance), mean * 0.25, 1)
  return { z: (Number(current) - mean) / std, current, mean }
}

/**
 * Decides whether Tabula may sign the next cumulative voucher. Pure: same inputs, same output.
 * Policy is evaluated on the delta (units × unitPrice) but the voucher that would be signed carries
 * `channel.signedCumulative + delta`; a signed voucher is claimable, so the first violating voucher
 * is the one refused.
 */
export function evaluate(state: PolicyState, req: VoucherRequest, policy: Policy): Decision {
  const unitsOk = Number.isSafeInteger(req.units) && req.units > 0
  const delta = unitsOk && req.unitPrice >= 0n ? BigInt(req.units) * req.unitPrice : 0n
  const newCumulative = state.channel.signedCumulative + delta
  const live = state.history.filter((e) => e.ts <= state.now)
  const dayStart = state.dayStartMs ?? utcDayStart(state.now)
  const taskSpent = sumWhere(live, (e) => e.taskId === req.taskId)
  const dailySpent = sumWhere(live, (e) => e.ts >= dayStart)
  const windows = policy.velocity.map((v) => ({
    rule: v,
    spent: sumWhere(live, (e) => e.ts > state.now - v.windowMs),
  }))

  let velocityHeadroom: bigint | null = null
  for (const w of windows) {
    const h = w.rule.max - w.spent
    if (velocityHeadroom === null || h < velocityHeadroom) velocityHeadroom = h
  }
  const remaining: Remaining = {
    task: policy.perTaskBudget === null ? null : policy.perTaskBudget - taskSpent,
    daily: policy.dailyBudget === null ? null : policy.dailyBudget - dailySpent,
    velocity: velocityHeadroom,
    channel: state.channel.deposit - state.channel.signedCumulative,
    ceiling: state.ceiling === null ? null : state.ceiling - state.channel.signedCumulative,
  }

  const base = { delta, newCumulative, remaining }
  const block = (rule: Rule, action: ViolationAction, detail: ViolationDetail): Decision => {
    const d: Decision = { verdict: 'block', rule, action, detail, ...base }
    return { ...d, reason: describeDecision(d, req) }
  }

  if (!unitsOk) {
    return block('INVALID_REQUEST', 'block', {
      limit: 0n,
      observed: 0n,
      message: 'units must be a positive integer',
    })
  }
  if (req.unitPrice < 0n || delta === 0n) {
    return block('INVALID_REQUEST', 'block', {
      limit: 0n,
      observed: req.unitPrice,
      message: 'unit price must be positive',
    })
  }
  if (state.globalKill) return block('GLOBAL_KILL', 'block', { limit: 0n, observed: delta })
  if (state.agentStatus === 'killed') return block('AGENT_KILLED', 'block', { limit: 0n, observed: delta })
  if (state.agentStatus === 'paused') return block('AGENT_PAUSED', 'block', { limit: 0n, observed: delta })

  const severe = policy.onViolation
  if (policy.vendorDeny.has(req.vendorId))
    return block('VENDOR_DENIED', severe, { limit: 0n, observed: delta })
  if (policy.vendorAllow !== null && !policy.vendorAllow.has(req.vendorId)) {
    return block('VENDOR_NOT_ALLOWED', severe, { limit: 0n, observed: delta })
  }
  if (policy.maxUnitPrice !== null && req.unitPrice > policy.maxUnitPrice) {
    return block('UNIT_PRICE', severe, { limit: policy.maxUnitPrice, observed: req.unitPrice })
  }
  // Hard caps: refusing is enough; a top-up (within the ceiling) can make room.
  if (newCumulative > state.channel.deposit) {
    return block('CHANNEL_DEPOSIT', 'block', { limit: state.channel.deposit, observed: newCumulative })
  }
  if (state.ceiling !== null && newCumulative > state.ceiling) {
    return block('ONCHAIN_CEILING', 'block', { limit: state.ceiling, observed: newCumulative })
  }
  // Budgets: exhaustion is expected, so it stops paying without killing the agent.
  if (policy.perTaskBudget !== null && taskSpent + delta > policy.perTaskBudget) {
    return block('TASK_BUDGET', 'block', { limit: policy.perTaskBudget, observed: taskSpent + delta })
  }
  if (policy.dailyBudget !== null && dailySpent + delta > policy.dailyBudget) {
    return block('DAILY_BUDGET', 'block', { limit: policy.dailyBudget, observed: dailySpent + delta })
  }
  // Runaway detection: these follow the policy's onViolation (kill_and_close by default).
  for (const w of windows) {
    if (w.spent + delta > w.rule.max) {
      return block('VELOCITY', severe, {
        limit: w.rule.max,
        observed: w.spent + delta,
        windowSec: w.rule.windowMs / 1000,
      })
    }
  }
  if (policy.anomaly !== null) {
    const stats = anomalyStats(live, state.now, policy.anomaly, delta)
    if (stats !== null && stats.z > policy.anomaly.zScore) {
      return block('ANOMALY', severe, {
        limit: BigInt(Math.round(policy.anomaly.zScore * 1000)),
        observed: stats.current,
        windowSec: policy.anomaly.bucketMs / 1000,
        zScore: stats.z,
        baselineMean: BigInt(Math.round(stats.mean)),
      })
    }
  }
  return { verdict: 'allow', ...base }
}

/** Reducer: the history after a voucher was signed. */
export function recordSpend(history: readonly SpendEvent[], event: SpendEvent): SpendEvent[] {
  return [...history, event]
}

/** Drops events older than every window the policy can look at (24h budget day at minimum). */
export function pruneHistory(history: readonly SpendEvent[], now: number, policy: Policy): SpendEvent[] {
  let keepMs = DAY_MS
  for (const v of policy.velocity) keepMs = Math.max(keepMs, v.windowMs)
  if (policy.anomaly) keepMs = Math.max(keepMs, policy.anomaly.bucketMs * (policy.anomaly.minSamples + 1))
  return history.filter((e) => e.ts > now - keepMs)
}
