'use client'

import { Download } from 'lucide-react'
import {
  Addr,
  Card,
  EmptyState,
  ExplorerLink,
  Kpi,
  PageHeader,
  ReconcileBadge,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { useTabula } from '@/lib/data/provider'
import { timeAgo, usd } from '@/lib/format'

export default function ReconciliationPage() {
  const { data, exportUrl, now } = useTabula()
  const rows = data.reconcile
  const matched = rows.filter((r) => r.status === 'MATCHED').length
  const settled = rows.reduce((s, r) => s + Number(r.settled), 0)
  const refunded = rows.filter((r) => r.refunded).reduce((s, r) => s + Number(r.refundDue), 0)

  return (
    <>
      <PageHeader
        title="Reconciliation"
        description="For every closed channel: the highest voucher Tabula signed, against what settled onchain. MATCHED means every signed voucher settled and the unspent escrow came back."
        actions={
          exportUrl ? (
            <a
              href={exportUrl}
              className="inline-flex items-center gap-1.5 rounded-full bg-wax px-4 py-2 text-sm font-medium text-ink hover:bg-wax-deep hover:text-paper"
            >
              <Download className="size-4" /> Export CSV
            </a>
          ) : (
            <span className="text-sm text-fg-2">Connect a live gateway to export the ledger CSV.</span>
          )
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Channels reconciled"
          value={`${matched} / ${rows.length}`}
          hint="MATCHED against the chain"
        />
        <Kpi label="Settled to vendors" value={usd(settled)} />
        <Kpi label="Escrow refunded" value={usd(refunded)} />
        <Kpi
          label="Needs attention"
          value={String(rows.length - matched)}
          hint={rows.length - matched ? 'see the rows below' : 'nothing'}
        />
      </div>
      <Card className="mt-6">
        {rows.length === 0 ? (
          <EmptyState title="No closed channels yet">
            Channels are reconciled when they close. Close a session or sweep idle channels to see them here.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Status</Th>
                <Th>Agent → vendor</Th>
                <Th>Channel</Th>
                <Th className="text-right">Deposit</Th>
                <Th className="text-right">Ledger signed</Th>
                <Th className="text-right">Settled onchain</Th>
                <Th className="text-right">Refund</Th>
                <Th>Explanation</Th>
                <Th>Closed</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sessionId}>
                  <Td>
                    <ReconcileBadge status={r.status} />
                  </Td>
                  <Td>
                    {r.agentId} → {r.vendorId}
                  </Td>
                  <Td>
                    <Addr value={r.channel} />
                  </Td>
                  <Td className="num text-right">{usd(r.deposit)}</Td>
                  <Td className="num text-right">{usd(r.ledgerSigned)}</Td>
                  <Td className="num text-right">{usd(r.settled)}</Td>
                  <Td className="num text-right">{r.refunded ? usd(r.refundDue) : 'pending'}</Td>
                  <Td className="max-w-[36ch] text-xs text-fg-2">
                    {r.explanation}
                    <span className="block text-muted">
                      {r.source === 'onchain'
                        ? 'read from the channel account'
                        : 'recorded when the channel closed'}
                    </span>
                  </Td>
                  <Td className="text-xs">
                    <ExplorerLink href={r.explorerUrl}>{timeAgo(r.closedAt, now)}</ExplorerLink>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  )
}
