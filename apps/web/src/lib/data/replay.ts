/**
 * Replay of a recorded `pnpm demo` run (public/replay/demo.json): the stream events plus API
 * snapshots taken every few seconds, so the hosted dashboard works without a gateway.
 */
import type {
  Agent,
  Batch,
  BatchVerification,
  ChallengeCheck,
  ChannelRow,
  DashboardData,
  FloatView,
  Overview,
  PolicyRow,
  ReconcileRow,
  Vendor,
  VendorScore,
  VoucherRow,
} from '../types'
import { type AuditRow, fromAudit, fromStream, type StreamEvent, voucherFromEvent } from './normalize'

export interface ReplaySnapshot {
  t: number
  overview: Overview
  agents: Agent[]
  vendors: Vendor[]
  float: FloatView
  channels: ChannelRow[]
  scores: VendorScore[]
  reconcile: ReconcileRow[]
  batches: Batch[]
  challenges: ChallengeCheck[]
  policies: PolicyRow[]
}

export interface ReplayFile {
  meta: {
    cluster: string
    rpcUrl: string
    recordedAt: string
    durationMs: number
    vault: string | null
    vaultStart: string
    vaultEnd: string
    timeScale: number
  }
  events: StreamEvent[]
  snapshots: ReplaySnapshot[]
  final: {
    vouchers: VoucherRow[]
    events: AuditRow[]
    batchDetails: Record<string, { rows: Record<string, unknown>[]; verification: BatchVerification }>
  }
}

export async function loadReplay(url = '/replay/demo.json'): Promise<ReplayFile> {
  const res = await fetch(url, { cache: 'force-cache' })
  if (!res.ok) throw new Error(`no recorded run at ${url}`)
  return (await res.json()) as ReplayFile
}

/** Dashboard state as it was `t` ms into the recording. */
export function stateAt(file: ReplayFile, t: number): DashboardData {
  const ended = t >= file.meta.durationMs
  let snap = file.snapshots[0]
  for (const s of file.snapshots) {
    if (s.t <= t) snap = s
    else break
  }
  const seen = file.events.filter((e) => (e.t ?? 0) <= t)
  let vouchers: VoucherRow[]
  if (ended) {
    vouchers = [...file.final.vouchers].sort((a, b) => b.id - a.id)
  } else {
    const byId = new Map<number, VoucherRow>()
    for (const e of seen) {
      if (e.type !== 'voucher') continue
      const row = voucherFromEvent(e)
      if (row) byId.set(row.id, row)
    }
    vouchers = [...byId.values()].sort((a, b) => b.id - a.id)
  }
  const timeline = ended
    ? file.final.events.map(fromAudit).sort((a, b) => b.ts - a.ts)
    : seen
        .filter((e) => e.type !== 'voucher')
        .map(fromStream)
        .sort((a, b) => b.ts - a.ts)
  return {
    overview: snap?.overview ?? null,
    agents: snap?.agents ?? [],
    vendors: snap?.vendors ?? [],
    channels: snap?.channels ?? [],
    float: snap?.float ?? null,
    scores: snap?.scores ?? [],
    reconcile: snap?.reconcile ?? [],
    batches: snap?.batches ?? [],
    challenges: snap?.challenges ?? [],
    policies: snap?.policies ?? [],
    vouchers,
    timeline,
  }
}

/** Events that happen while a run is still setting up (escrow sizing, funding): nothing to look at yet. */
const SETUP_EVENTS = new Set(['float_sized', 'top_up', 'faucet'])

/**
 * Where playback starts: just before the first thing worth watching. A devnet recording spends its first
 * half-minute sizing escrow and pulling funds, and the dashboard would sit empty all that time. The setup
 * events still show in the timeline, since everything before the start counts as seen.
 */
export function replayStart(file: ReplayFile): number {
  const first = file.events.find((e) => !SETUP_EVENTS.has(e.type))
  return first ? Math.max(0, (first.t ?? 0) - 1_500) : 0
}

/** Wall-clock time in the recording at offset t (for "x minutes ago" labels during replay). */
export function recordedNow(file: ReplayFile, t: number): number {
  return Date.parse(file.meta.recordedAt) + t
}
