import { address } from '@solana/kit'
import { type LedgerDb, type ReconcileStatus, reconcileChannel, schema, vendorScores } from '@tabula/ledger'
import { desc, eq, gte, inArray } from '@tabula/ledger/sql'
import {
  type ClusterConfig,
  explorerAddressUrl,
  explorerTxUrl,
  fetchChannelView,
  type SolanaRpc,
} from '@tabula/solana'

export interface ReconcileRow {
  readonly sessionId: string
  readonly agentId: string
  readonly vendorId: string
  readonly channel: string | null
  readonly deposit: string
  readonly ledgerSigned: string
  readonly settled: string
  readonly refundDue: string
  readonly refunded: boolean
  readonly status: ReconcileStatus
  readonly explanation: string
  readonly source: 'onchain' | 'recorded-at-close'
  readonly closedAt: number | null
  readonly closeTx: string | null
  readonly explorerUrl: string | null
}

/**
 * One row per closed channel: the highest voucher the ledger says Tabula signed vs the `settled`
 * watermark onchain. The channel account is re-read when it still exists (a distributed channel
 * keeps its watermark until `reclaim`); once deallocated, the value recorded at close is used.
 */
export async function reconcileAll(
  db: LedgerDb,
  rpc: SolanaRpc,
  cluster: ClusterConfig,
  /** The most recently closed channels only (each one is an RPC read). */
  limit?: number,
): Promise<ReconcileRow[]> {
  const q = db
    .select()
    .from(schema.channels)
    .where(inArray(schema.channels.status, ['sealed', 'refunded']))
    .orderBy(desc(schema.channels.closedAt))
  const closed = limit === undefined ? await q : await q.limit(limit)
  const rows: ReconcileRow[] = []
  for (const c of closed) {
    // the ledger's view: the highest cumulative among rows Tabula actually signed (blocked rows excluded)
    const ledgerSigned = (await db.select().from(schema.vouchers).where(eq(schema.vouchers.channelId, c.id)))
      .filter((v) => v.verdict === 'signed')
      .reduce((m, v) => (BigInt(v.cumulativeAmount) > m ? BigInt(v.cumulativeAmount) : m), 0n)
    let settled = BigInt(c.settledAmount ?? 0)
    let source: ReconcileRow['source'] = 'recorded-at-close'
    if (c.channelPda) {
      try {
        const view = await fetchChannelView(rpc, address(c.channelPda))
        if (view.exists) {
          settled = view.settled
          source = 'onchain'
        }
      } catch {
        // RPC hiccup: fall back to the recorded value
      }
    }
    const r = reconcileChannel({
      ledgerSigned,
      deposit: BigInt(c.deposit),
      settled,
      refunded: c.status === 'refunded',
    })
    rows.push({
      sessionId: c.id,
      agentId: c.agentId,
      vendorId: c.vendorId,
      channel: c.channelPda,
      deposit: String(c.deposit),
      ledgerSigned: ledgerSigned.toString(),
      settled: settled.toString(),
      refundDue: r.refundDue.toString(),
      refunded: c.status === 'refunded',
      status: r.status,
      explanation:
        r.status === 'LEDGER_AHEAD' && (c.closeReason ?? '').includes('kill') && settled === 0n
          ? 'The vendor never settled within the grace period; its signed vouchers expired unclaimed.'
          : r.explanation,
      source,
      closedAt: c.closedAt,
      closeTx: c.closeTx,
      explorerUrl: c.closeTx
        ? explorerTxUrl(cluster, c.closeTx)
        : c.channelPda
          ? explorerAddressUrl(cluster, c.channelPda)
          : null,
    })
  }
  return rows
}

export async function scorecards(db: LedgerDb) {
  const vouchers = await db.select().from(schema.vouchers)
  const tasks = await db.select().from(schema.tasks)
  return vendorScores(vouchers, tasks)
}

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Every voucher, signed or blocked, as an accounting-friendly CSV (amounts in USD). */
export async function exportCsv(db: LedgerDb, cluster: ClusterConfig): Promise<string> {
  const [vouchers, tasks, agents, channels, batches] = await Promise.all([
    db.select().from(schema.vouchers).orderBy(schema.vouchers.id),
    db.select().from(schema.tasks),
    db.select().from(schema.agents),
    db.select().from(schema.channels),
    db.select().from(schema.batches),
  ])
  const task = new Map(tasks.map((t) => [t.id, t]))
  const agent = new Map(agents.map((a) => [a.id, a]))
  const channel = new Map(channels.map((c) => [c.id, c]))
  const batch = new Map(batches.map((b) => [b.id, b]))
  const header = [
    'voucher_id',
    'timestamp_utc',
    'agent',
    'department',
    'task_id',
    'task',
    'customer_tag',
    'vendor',
    'channel',
    'verdict',
    'rule',
    'reason',
    'amount_usd',
    'cumulative_usd',
    'units',
    'unit_price_usd',
    'vendor_response',
    'latency_ms',
    'voucher_signature',
    'batch_id',
    'batch_tx',
    'batch_tx_url',
  ]
  const lines = [header.join(',')]
  for (const v of vouchers) {
    const t = task.get(v.taskId)
    const b = v.batchId ? batch.get(v.batchId) : undefined
    lines.push(
      [
        v.id,
        new Date(v.ts).toISOString(),
        v.agentId,
        agent.get(v.agentId)?.department,
        v.taskId,
        t?.label,
        t?.customerTag,
        v.vendorId,
        channel.get(v.channelId)?.channelPda,
        v.verdict,
        v.ruleTriggered,
        v.reason,
        (v.delta / 1e6).toFixed(6),
        (v.cumulativeAmount / 1e6).toFixed(6),
        v.unitCount,
        (v.unitPrice / 1e6).toFixed(6),
        v.responseStatus,
        v.latencyMs,
        v.signature,
        v.batchId,
        b?.txSignature,
        b?.txSignature ? explorerTxUrl(cluster, b.txSignature) : '',
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return `${lines.join('\n')}\n`
}

export async function overview(db: LedgerDb, now = Date.now()) {
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000
  const hourStart = Math.floor(now / 3_600_000) * 3_600_000
  const weekAgo = now - 7 * 86_400_000
  const today = await db.select().from(schema.vouchers).where(gte(schema.vouchers.ts, dayStart))
  const signedToday = today.filter((v) => v.verdict === 'signed')
  const channels = await db.select().from(schema.channels)
  const sweeps = await db.select().from(schema.events).where(eq(schema.events.type, 'sweep'))
  const reclaimedEscrow = channels
    .filter((c) => (c.closedAt ?? 0) >= weekAgo)
    .reduce((a, c) => a + (c.refundedAmount ?? 0), 0)
  const swept = sweeps
    .filter((e) => e.ts >= weekAgo)
    .reduce((a, e) => a + Number((JSON.parse(e.dataJson) as { amount?: string }).amount ?? 0), 0)
  const agents = await db.select().from(schema.agents)
  return {
    spendToday: signedToday.reduce((a, v) => a + v.delta, 0),
    spendThisHour: signedToday.filter((v) => v.ts >= hourStart).reduce((a, v) => a + v.delta, 0),
    vouchersToday: signedToday.length,
    blockedToday: today.length - signedToday.length,
    activeAgents: agents.filter((a) => a.status === 'active').length,
    totalAgents: agents.length,
    escrowTiedUp: channels
      .filter((c) => c.status === 'open')
      .reduce((a, c) => a + c.deposit - c.signedCumulative, 0),
    openChannels: channels.filter((c) => c.status === 'open').length,
    escrowReclaimedThisWeek: reclaimedEscrow,
    sweptToVaultThisWeek: swept,
  }
}
