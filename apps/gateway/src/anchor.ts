/**
 * Onchain receipts. Every N finalized vouchers (or every interval), the batcher takes the next
 * contiguous run of ledger rows, computes a sorted-pair SHA-256 Merkle root over their canonical
 * form, writes `tabula:v1 batch=… root=…` with the SPL Memo program, and stamps the rows with the
 * batch id. Anyone holding the rows can recompute the root and compare it with the memo onchain.
 */

import type { KeyPairSigner } from '@solana/kit'
import {
  canonicalVoucher,
  first,
  formatBatchMemo,
  type LedgerDb,
  merkleRoot,
  parseBatchMemo,
  schema,
  withLock,
} from '@tabula/ledger'
import { and, asc, eq, gt, isNull, sql } from '@tabula/ledger/sql'
import {
  buildMemoInstruction,
  type ClusterConfig,
  explorerTxUrl,
  fetchTransactionMemos,
  type SolanaRpc,
  sendAndConfirm,
} from '@tabula/solana'
import type { EventBus } from './events'
import { KeyedMutex } from './util'

export interface BatchVerification {
  readonly batchId: number
  readonly voucherCount: number
  readonly storedRoot: string
  readonly recomputedRoot: string
  readonly onchainRoot: string | null
  readonly txSignature: string | null
  readonly explorerUrl: string | null
  readonly match: boolean
  readonly reason: string
}

export class Anchorer {
  readonly #lock = new KeyedMutex()

  constructor(
    private readonly db: LedgerDb,
    private readonly rpc: SolanaRpc,
    private readonly cluster: ClusterConfig,
    private readonly operator: KeyPairSigner,
    private readonly bus: EventBus,
    private readonly maxPerBatch = 500,
  ) {}

  /** Rows ready to anchor: unbatched, in id order, stopping at the first row still awaiting a vendor response. */
  async pendingRows(limit = this.maxPerBatch, db: LedgerDb = this.db): Promise<schema.VoucherRow[]> {
    const rows = await db
      .select()
      .from(schema.vouchers)
      .where(isNull(schema.vouchers.batchId))
      .orderBy(asc(schema.vouchers.id))
      .limit(limit)
    const ready: schema.VoucherRow[] = []
    for (const r of rows) {
      if (r.verdict === 'signed' && r.responseStatus === null) break
      ready.push(r)
    }
    return ready
  }

  async pendingCount(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(schema.vouchers)
      .where(isNull(schema.vouchers.batchId))
    return Number(row?.n ?? 0)
  }

  /**
   * Anchors the next batch if there is anything to anchor. The rows are claimed first (stamped with a
   * pending batch under a cross-instance lock), then the memo is sent outside the transaction; a failed
   * send releases them. So instances sharing one database never anchor the same rows twice.
   */
  async anchorNext(minRows = 1): Promise<schema.BatchRow | null> {
    return this.#lock.run('anchor', async () => {
      const claim = await withLock(this.db, 'anchor', async (tx) => {
        const rows = await this.pendingRows(this.maxPerBatch, tx)
        if (rows.length < minRows || rows.length === 0) return null
        const root = merkleRoot(rows.map(canonicalVoucher))
        const first = rows[0]!.id
        const last = rows[rows.length - 1]!.id
        const [batch] = await tx
          .insert(schema.batches)
          .values({
            merkleRoot: root,
            voucherCount: rows.length,
            firstVoucherId: first,
            lastVoucherId: last,
            status: 'pending',
            createdAt: Date.now(),
          })
          .returning()
        await tx
          .update(schema.vouchers)
          .set({ batchId: batch!.id })
          .where(
            and(
              gt(schema.vouchers.id, first - 1),
              sql`${schema.vouchers.id} <= ${last}`,
              isNull(schema.vouchers.batchId),
            ),
          )
        return { rows, root, first, last, batch: batch! }
      })
      if (!claim) return null
      const { rows, root, first, last, batch } = claim
      const memo = formatBatchMemo({
        batchId: batch.id,
        count: rows.length,
        firstVoucherId: first,
        lastVoucherId: last,
        root,
      })
      let tx: string
      try {
        tx = await sendAndConfirm(this.rpc, {
          feePayer: this.operator,
          instructions: [buildMemoInstruction(memo, this.operator)],
        })
      } catch (err) {
        // release the rows so the next attempt anchors them
        await this.db.transaction(async (t) => {
          await t.update(schema.vouchers).set({ batchId: null }).where(eq(schema.vouchers.batchId, batch.id))
          await t.update(schema.batches).set({ status: 'failed' }).where(eq(schema.batches.id, batch.id))
        })
        throw err
      }
      const anchoredAt = Date.now()
      const [updated] = await this.db
        .update(schema.batches)
        .set({ status: 'anchored', txSignature: tx, anchoredAt })
        .where(eq(schema.batches.id, batch.id))
        .returning()
      await this.bus.emit({
        type: 'batch_anchored',
        message: `Anchored ledger batch #${batch.id}: ${rows.length} vouchers, Merkle root ${root.slice(0, 12)}…`,
        txSignature: tx,
        explorerUrl: explorerTxUrl(this.cluster, tx),
        data: {
          batchId: batch.id,
          root,
          count: rows.length,
          firstVoucherId: first,
          lastVoucherId: last,
          memo,
        },
      })
      return updated!
    })
  }

  /** Anchors everything that is ready (used at shutdown and at the end of the demo). */
  async anchorAll(): Promise<schema.BatchRow[]> {
    const out: schema.BatchRow[] = []
    for (;;) {
      const b = await this.anchorNext()
      if (!b) return out
      out.push(b)
    }
  }

  /** The rows of a batch in canonical form, in leaf order (what the dashboard hashes client-side). */
  async batchRows(batchId: number) {
    const rows = await this.db
      .select()
      .from(schema.vouchers)
      .where(eq(schema.vouchers.batchId, batchId))
      .orderBy(asc(schema.vouchers.id))
    return rows.map(canonicalVoucher)
  }

  /** Recomputes the root from the ledger and compares it with the memo onchain. */
  async verify(batchId: number): Promise<BatchVerification> {
    const batch = await first(this.db.select().from(schema.batches).where(eq(schema.batches.id, batchId)))
    if (!batch) throw new Error(`no batch ${batchId}`)
    const rows = await this.batchRows(batchId)
    const recomputedRoot = rows.length ? merkleRoot(rows) : ''
    let onchainRoot: string | null = null
    if (batch.txSignature) {
      for (const memo of await fetchTransactionMemos(this.rpc, batch.txSignature)) {
        const parsed = parseBatchMemo(memo)
        if (parsed?.batchId === batchId) onchainRoot = parsed.root
      }
    }
    const match =
      onchainRoot !== null &&
      onchainRoot === recomputedRoot &&
      recomputedRoot === batch.merkleRoot &&
      rows.length === batch.voucherCount
    let reason: string
    if (!batch.txSignature) reason = 'batch was never anchored onchain'
    else if (onchainRoot === null) reason = 'no Tabula memo found in the anchoring transaction'
    else if (rows.length !== batch.voucherCount)
      reason = `ledger has ${rows.length} rows for this batch, the memo commits to ${batch.voucherCount}`
    else if (recomputedRoot !== onchainRoot)
      reason = 'the ledger rows no longer hash to the root anchored onchain: they were changed'
    else reason = `all ${rows.length} rows hash to the root anchored onchain`
    return {
      batchId,
      voucherCount: rows.length,
      storedRoot: batch.merkleRoot,
      recomputedRoot,
      onchainRoot,
      txSignature: batch.txSignature,
      explorerUrl: batch.txSignature ? explorerTxUrl(this.cluster, batch.txSignature) : null,
      match,
      reason,
    }
  }
}
