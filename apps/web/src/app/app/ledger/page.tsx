'use client'

import { merkleRoot } from '@tabula/ledger/merkle'
import { CircleCheck, OctagonX, Receipt } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ExplorerLink,
  PageHeader,
  Table,
  Td,
  Th,
  VerdictBadge,
} from '@/components/ui'
import { useTabula } from '@/lib/data/provider'
import { clock, RULE_LABEL, timeAgo, usd } from '@/lib/format'
import type { Batch, BatchVerification } from '@/lib/types'

interface VerifyResult {
  local: string
  verification: BatchVerification
  ms: number
}

function BatchRow({ b }: { b: Batch }) {
  const { actions, data, now } = useTabula()
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const explorer = data.timeline.find((t) => t.txSignature === b.txSignature)?.explorerUrl ?? null

  const verify = async () => {
    setState('busy')
    setError(null)
    try {
      const started = performance.now()
      const rows = await actions.batchRows(b.id)
      const local = merkleRoot(rows) // recomputed here, in your browser
      const verification = await actions.verifyBatch(b.id)
      setResult({ local, verification, ms: Math.round(performance.now() - started) })
      setState('done')
    } catch (err) {
      setError((err as Error).message)
      setState('error')
    }
  }
  const ok = result && result.local === result.verification.onchainRoot && result.local === b.merkleRoot
  return (
    <>
      <tr>
        <Td className="num">#{b.id}</Td>
        <Td className="num">{b.voucherCount}</Td>
        <Td className="font-mono text-xs" title={b.merkleRoot}>
          {b.merkleRoot.slice(0, 20)}…
        </Td>
        <Td>
          {b.status === 'anchored' ? (
            <ExplorerLink href={explorer ?? result?.verification.explorerUrl ?? null}>
              {b.txSignature?.slice(0, 10)}…
            </ExplorerLink>
          ) : (
            <Badge tone="warn">{b.status}</Badge>
          )}
        </Td>
        <Td className="text-xs text-fg-2">{timeAgo(b.anchoredAt, now)}</Td>
        <Td className="text-right">
          <Button onClick={verify} disabled={state === 'busy' || b.status !== 'anchored'}>
            {state === 'busy' ? 'Verifying…' : 'Verify'}
          </Button>
        </Td>
      </tr>
      {state === 'done' && result ? (
        <tr>
          <Td colSpan={6} className="bg-surface-2/60">
            <div className="flex flex-wrap items-start gap-3 text-sm">
              {ok ? (
                <Badge tone="matched" icon={<CircleCheck className="size-3" aria-hidden />}>
                  MATCHED
                </Badge>
              ) : (
                <Badge tone="sever" icon={<OctagonX className="size-3" aria-hidden />}>
                  MISMATCH
                </Badge>
              )}
              <div className="min-w-0 flex-1 space-y-1">
                <p>
                  {ok
                    ? `All ${b.voucherCount} ledger rows hash to the root anchored onchain (recomputed in your browser in ${result.ms} ms).`
                    : result.verification.reason}
                </p>
                <p className="font-mono text-xs break-all text-fg-2">browser: {result.local}</p>
                <p className="font-mono text-xs break-all text-fg-2">
                  onchain: {result.verification.onchainRoot ?? 'not found'}
                </p>
              </div>
            </div>
          </Td>
        </tr>
      ) : null}
      {state === 'error' ? (
        <tr>
          <Td colSpan={6} className="text-sm text-sever">
            {error}
          </Td>
        </tr>
      ) : null}
    </>
  )
}

export default function LedgerPage() {
  const { data } = useTabula()
  const [agent, setAgent] = useState('all')
  const [vendor, setVendor] = useState('all')
  const [verdict, setVerdict] = useState('all')
  const rows = useMemo(
    () =>
      data.vouchers.filter(
        (v) =>
          (agent === 'all' || v.agentId === agent) &&
          (vendor === 'all' || v.vendorId === vendor) &&
          (verdict === 'all' || v.verdict === verdict),
      ),
    [data.vouchers, agent, vendor, verdict],
  )
  const vendors = [...new Set(data.vouchers.map((v) => v.vendorId))]
  const select = 'rounded-full border border-line bg-surface px-3 py-1.5 text-sm'

  return (
    <>
      <PageHeader
        title="Ledger"
        description="Every voucher, signed or blocked. Rows are committed in batches: a Merkle root over each batch is anchored onchain with the Memo program, so anyone can check the ledger has not been edited."
      />
      <Card>
        <CardHeader
          title="Onchain receipts"
          subtitle="Sorted-pair SHA-256 Merkle tree over canonical rows. Verify recomputes the root here and compares it with the memo onchain."
        />
        {data.batches.length === 0 ? (
          <EmptyState title="No batches anchored yet">
            The gateway anchors a batch every 40 vouchers. <Receipt className="inline size-4" aria-hidden />
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Batch</Th>
                <Th>Vouchers</Th>
                <Th>Merkle root</Th>
                <Th>Memo transaction</Th>
                <Th>Anchored</Th>
                <Th className="text-right">Check</Th>
              </tr>
            </thead>
            <tbody>
              {data.batches.map((b) => (
                <BatchRow key={b.id} b={b} />
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <fieldset className="mt-6 flex flex-wrap items-center gap-2">
        <legend className="sr-only">Filter vouchers</legend>
        <select
          className={select}
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          aria-label="Agent"
        >
          <option value="all">All agents</option>
          {data.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id}
            </option>
          ))}
        </select>
        <select
          className={select}
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          aria-label="Vendor"
        >
          <option value="all">All vendors</option>
          {vendors.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select
          className={select}
          value={verdict}
          onChange={(e) => setVerdict(e.target.value)}
          aria-label="Verdict"
        >
          <option value="all">Signed and blocked</option>
          <option value="signed">Signed</option>
          <option value="blocked">Blocked</option>
        </select>
        <span className="text-sm text-fg-2">{rows.length} vouchers</span>
      </fieldset>

      <Card className="mt-3">
        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Time</Th>
              <Th>Agent</Th>
              <Th>Vendor</Th>
              <Th>Task</Th>
              <Th>Verdict</Th>
              <Th className="text-right">Amount</Th>
              <Th className="text-right">Cumulative</Th>
              <Th>Vendor result</Th>
              <Th>Batch</Th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 300).map((v) => (
              <tr key={v.id} className={v.verdict === 'blocked' ? 'bg-sever/[0.05]' : undefined}>
                <Td className="num text-fg-2">{v.id}</Td>
                <Td className="num text-xs">{clock(v.ts)}</Td>
                <Td>{v.agentId}</Td>
                <Td>{v.vendorId}</Td>
                <Td className="font-mono text-xs">{v.taskId}</Td>
                <Td>
                  <span className="inline-flex flex-col gap-0.5">
                    <VerdictBadge verdict={v.verdict} />
                    {v.ruleTriggered ? (
                      <span className="text-xs text-fg-2">
                        {RULE_LABEL[v.ruleTriggered] ?? v.ruleTriggered}
                      </span>
                    ) : null}
                  </span>
                </Td>
                <Td className="num text-right">{usd(v.delta)}</Td>
                <Td className="num text-right">{usd(v.cumulativeAmount)}</Td>
                <Td className="text-xs text-fg-2">
                  {v.responseStatus ?? (v.verdict === 'blocked' ? 'not sent' : '…')}
                  {v.latencyMs !== null ? ` · ${v.latencyMs} ms` : ''}
                </Td>
                <Td className="num text-xs text-fg-2">{v.batchId ? `#${v.batchId}` : 'pending'}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {rows.length > 300 ? (
          <p className="px-5 py-3 text-xs text-fg-2">
            Showing the latest 300. Export the CSV from Reconciliation for everything.
          </p>
        ) : null}
      </Card>
    </>
  )
}
