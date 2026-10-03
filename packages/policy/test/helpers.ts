import type { PolicyState, SpendEvent, VoucherRequest } from '../src/evaluate.js'

export const T0 = Date.UTC(2026, 9, 4, 12, 0, 0) // 2026-10-04T12:00:00Z

export function state(over: Partial<PolicyState> = {}): PolicyState {
  return {
    now: T0,
    globalKill: false,
    agentStatus: 'active',
    history: [],
    channel: { deposit: 10_000_000n, signedCumulative: 0n },
    ceiling: null,
    ...over,
  }
}

export function req(over: Partial<VoucherRequest> = {}): VoucherRequest {
  return {
    agentId: 'research-01',
    taskId: 'task-1',
    vendorId: 'inference-a',
    units: 10,
    unitPrice: 100n,
    ...over,
  }
}

export function spend(ts: number, amount: bigint, taskId = 'task-1', vendorId = 'inference-a'): SpendEvent {
  return { ts, amount, taskId, vendorId }
}
