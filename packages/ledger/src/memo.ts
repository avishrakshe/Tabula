/**
 * Onchain receipt memo for one ledger batch, written with the SPL Memo program:
 *
 *   tabula:v1 batch=<id> n=<count> first=<voucherId> last=<voucherId> root=<64 hex>
 *
 * Small (<120 bytes), human-readable in any explorer, and parseable by `scripts/verify-batch.ts`.
 */
export interface BatchMemo {
  readonly batchId: number
  readonly count: number
  readonly firstVoucherId: number
  readonly lastVoucherId: number
  readonly root: string
}

const PREFIX = 'tabula:v1'

export function formatBatchMemo(m: BatchMemo): string {
  if (!/^[0-9a-f]{64}$/.test(m.root)) throw new Error('root must be 64 lowercase hex chars')
  return `${PREFIX} batch=${m.batchId} n=${m.count} first=${m.firstVoucherId} last=${m.lastVoucherId} root=${m.root}`
}

export function parseBatchMemo(text: string): BatchMemo | null {
  // explorers/RPCs sometimes prefix memo logs with a length marker like "[95] "
  const body = text.replace(/^\[\d+\]\s*/, '').trim()
  const m = /^tabula:v1 batch=(\d+) n=(\d+) first=(\d+) last=(\d+) root=([0-9a-f]{64})$/.exec(body)
  if (!m) return null
  return {
    batchId: Number(m[1]),
    count: Number(m[2]),
    firstVoucherId: Number(m[3]),
    lastVoucherId: Number(m[4]),
    root: m[5]!,
  }
}
