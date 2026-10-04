import type { TimelineItem, VoucherRow } from '../types'

/** Audit-log row from GET /v1/events. */
export interface AuditRow {
  id: number
  ts: number
  type: string
  agentId: string | null
  channelId: string | null
  message: string
  dataJson: string
  txSignature: string | null
}

/** Event as pushed on GET /v1/stream (and recorded in the replay fixture). */
export interface StreamEvent {
  id?: number
  type: string
  ts: number
  message: string
  agentId?: string | null
  channelId?: string | null
  txSignature?: string | null
  explorerUrl?: string | null
  data?: Record<string, unknown>
  /** replay only: ms since the recording started */
  t?: number
}

export function fromAudit(r: AuditRow): TimelineItem {
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(r.dataJson) as Record<string, unknown>
  } catch {
    // keep empty
  }
  return {
    key: `a${r.id}`,
    ts: r.ts,
    type: r.type,
    agentId: r.agentId,
    channelId: r.channelId,
    message: r.message,
    txSignature: r.txSignature,
    explorerUrl: (data.explorerUrl as string | undefined) ?? null,
    data,
  }
}

export function fromStream(e: StreamEvent): TimelineItem {
  return {
    key: e.id ? `a${e.id}` : `s${e.ts}-${e.type}-${e.message.length}`,
    ts: e.ts,
    type: e.type,
    agentId: e.agentId ?? null,
    channelId: e.channelId ?? null,
    message: e.message,
    txSignature: e.txSignature ?? null,
    explorerUrl: e.explorerUrl ?? null,
    data: e.data ?? {},
  }
}

export function voucherFromEvent(e: StreamEvent): VoucherRow | null {
  const row = (e.data as { row?: VoucherRow } | undefined)?.row
  return row && typeof row.id === 'number' ? row : null
}

/** Merges rows by id (later wins), newest first. */
export function mergeVouchers(existing: VoucherRow[], incoming: VoucherRow[], cap = 5000): VoucherRow[] {
  const map = new Map<number, VoucherRow>()
  for (const v of existing) map.set(v.id, v)
  for (const v of incoming) map.set(v.id, v)
  return [...map.values()].sort((a, b) => b.id - a.id).slice(0, cap)
}

export function mergeTimeline(
  existing: TimelineItem[],
  incoming: TimelineItem[],
  cap = 1000,
): TimelineItem[] {
  const map = new Map<string, TimelineItem>()
  for (const t of existing) map.set(t.key, t)
  for (const t of incoming) map.set(t.key, t)
  return [...map.values()].sort((a, b) => b.ts - a.ts).slice(0, cap)
}
