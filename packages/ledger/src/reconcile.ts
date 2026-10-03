/**
 * Reconciliation of one channel: Tabula's ledger (what it signed) against the chain (what settled).
 *
 * - CHAIN_AHEAD    settled onchain > highest voucher Tabula signed. Should be impossible — it means a
 *                  voucher Tabula never signed was settled (key compromise or a ledger gap). Red alert.
 * - LEDGER_AHEAD   Tabula signed more than has settled. Normal while a channel is open; after close it
 *                  means the vendor left signed vouchers unclaimed.
 * - REFUND_PENDING settled == signed, but the unspent escrow has not come back to the payer yet.
 * - MATCHED        settled == signed and the remainder is back (or there was none).
 */
export type ReconcileStatus = 'MATCHED' | 'LEDGER_AHEAD' | 'CHAIN_AHEAD' | 'REFUND_PENDING'

export interface ReconcileInput {
  /** Highest cumulative voucher Tabula signed (ledger). */
  readonly ledgerSigned: bigint
  readonly deposit: bigint
  /** Onchain `settled` watermark (from the channel account, or the last known value before it closed). */
  readonly settled: bigint
  /** Whether `deposit - settled` has been returned to the payer (distribute or withdraw_payer ran). */
  readonly refunded: boolean
}

export interface ReconcileResult {
  readonly status: ReconcileStatus
  /** settled - ledgerSigned (negative = ledger ahead). */
  readonly difference: bigint
  readonly refundDue: bigint
  readonly explanation: string
}

export function reconcileChannel(r: ReconcileInput): ReconcileResult {
  const difference = r.settled - r.ledgerSigned
  const refundDue = r.deposit - r.settled
  if (difference > 0n) {
    return {
      status: 'CHAIN_AHEAD',
      difference,
      refundDue,
      explanation: 'More settled onchain than Tabula ever signed. Investigate immediately.',
    }
  }
  if (difference < 0n) {
    return {
      status: 'LEDGER_AHEAD',
      difference,
      refundDue,
      explanation: 'Signed vouchers have not all settled onchain yet.',
    }
  }
  if (refundDue > 0n && !r.refunded) {
    return {
      status: 'REFUND_PENDING',
      difference,
      refundDue,
      explanation: 'Settlement matches; the unspent escrow has not been returned yet.',
    }
  }
  return {
    status: 'MATCHED',
    difference,
    refundDue,
    explanation: 'Every signed voucher settled and the unspent escrow is back.',
  }
}
