import type { Decision, VoucherRequest } from './evaluate'
import { formatUsd } from './money'

/**
 * Plain-language explanation of a decision, e.g.
 * "Stopped paying research-01: spent $0.62 in 60s (limit $0.50)".
 * `name` defaults to the agent id; the gateway may pass a display name.
 */
export function describeDecision(
  d: Pick<Decision, 'verdict' | 'rule' | 'detail' | 'delta' | 'remaining'>,
  req: Pick<VoucherRequest, 'agentId' | 'taskId' | 'vendorId'>,
  name: string = req.agentId,
): string {
  if (d.verdict === 'allow') return `Paid ${req.vendorId} ${formatUsd(d.delta)} for ${name}`
  const limit = d.detail?.limit ?? 0n
  const observed = d.detail?.observed ?? 0n
  switch (d.rule) {
    case 'INVALID_REQUEST':
      return `Rejected a payment request from ${name}: ${d.detail?.message ?? 'invalid request'}`
    case 'GLOBAL_KILL':
      return `Did not pay for ${name}: all agent payments are stopped (global kill switch is on)`
    case 'AGENT_KILLED':
      return `Did not pay for ${name}: this agent was stopped and no further payments are signed`
    case 'AGENT_PAUSED':
      return `Did not pay for ${name}: this agent is paused`
    case 'VENDOR_DENIED':
      return `Blocked ${name}: ${req.vendorId} is on the deny list`
    case 'VENDOR_NOT_ALLOWED':
      return `Blocked ${name}: ${req.vendorId} is not an approved vendor`
    case 'UNIT_PRICE':
      return `Blocked ${name}: ${req.vendorId} asked ${formatUsd(observed)} per unit (max ${formatUsd(limit)})`
    case 'CHANNEL_DEPOSIT':
      return `Paused paying ${req.vendorId} for ${name}: the escrow is used up (${formatUsd(limit)} deposited); a top-up is needed`
    case 'ONCHAIN_CEILING':
      return `Blocked ${name}: this payment would pass its onchain allowance (${formatUsd(limit)} cap)`
    case 'TASK_BUDGET':
      return `Stopped paying for ${name}'s task ${req.taskId}: it would reach ${formatUsd(observed)} (task budget ${formatUsd(limit)})`
    case 'DAILY_BUDGET':
      return `Stopped paying ${name}: today's spend would reach ${formatUsd(observed)} (daily budget ${formatUsd(limit)})`
    case 'VELOCITY':
      return `Stopped paying ${name}: spent ${formatUsd(observed)} in ${d.detail?.windowSec}s (limit ${formatUsd(limit)})`
    case 'ANOMALY':
      return `Stopped paying ${name}: spend jumped to ${formatUsd(observed)} per ${d.detail?.windowSec}s, ${(
        d.detail?.zScore ?? 0
      ).toFixed(1)}σ above its usual ${formatUsd(d.detail?.baselineMean ?? 0n)}`
    default:
      return `Blocked a payment for ${name}`
  }
}
