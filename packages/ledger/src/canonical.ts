/**
 * Canonical serialization for ledger rows: JSON with object keys sorted lexicographically at every
 * level, bigints as decimal strings, `undefined` fields dropped, no whitespace. Two rows with the
 * same content always serialize to the same bytes, in Node and in the browser.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'bigint':
      return JSON.stringify(value.toString())
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`cannot canonicalize non-finite number ${value}`)
      return JSON.stringify(value)
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
    }
    default:
      throw new TypeError(`cannot canonicalize ${typeof value}`)
  }
}

/** The voucher fields committed to by a batch root. `batchId` is excluded: it is assigned after hashing. */
export interface CanonicalVoucher {
  readonly id: number
  readonly channelId: string
  readonly agentId: string
  readonly taskId: string
  readonly vendorId: string
  readonly cumulativeAmount: number
  readonly delta: number
  readonly unitCount: number
  readonly unitPrice: number
  readonly verdict: string
  readonly ruleTriggered: string | null
  readonly signature: string | null
  readonly responseStatus: string | null
  readonly latencyMs: number | null
  readonly ts: number
}

export function canonicalVoucher(row: CanonicalVoucher): CanonicalVoucher {
  return {
    id: row.id,
    channelId: row.channelId,
    agentId: row.agentId,
    taskId: row.taskId,
    vendorId: row.vendorId,
    cumulativeAmount: row.cumulativeAmount,
    delta: row.delta,
    unitCount: row.unitCount,
    unitPrice: row.unitPrice,
    verdict: row.verdict,
    ruleTriggered: row.ruleTriggered,
    signature: row.signature,
    responseStatus: row.responseStatus,
    latencyMs: row.latencyMs,
    ts: row.ts,
  }
}
