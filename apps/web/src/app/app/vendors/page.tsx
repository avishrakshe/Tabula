'use client'

import { Ban, Sparkles } from 'lucide-react'
import { Addr, Badge, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th } from '@/components/ui'
import { useTabula } from '@/lib/data/provider'
import { clock, usd } from '@/lib/format'

export default function VendorsPage() {
  const { data } = useTabula()
  const blocked = data.challenges.filter((c) => c.verdict !== 'OK')
  const maxCost = Math.max(1, ...data.scores.map((s) => s.costPerCompletedTask ?? 0))

  return (
    <>
      <PageHeader
        title="Vendors"
        description="Who actually delivers per dollar. Waste is spend on calls that errored, timed out or came back empty. Every payment request is checked against this registry before anything is signed."
      />

      <Card>
        <CardHeader
          title="Scorecards"
          subtitle="Computed from this ledger's own paid calls and completed tasks."
        />
        {data.scores.length === 0 ? (
          <EmptyState title="No paid calls yet">Scorecards fill in as agents complete tasks.</EmptyState>
        ) : (
          <div className="grid gap-4 p-5 md:grid-cols-2">
            {data.scores.map((s) => (
              <article key={`${s.vendorId}-${s.taskType}`} className="rounded-2xl border border-line p-4">
                <header className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-h5 font-medium">{s.vendorId}</h3>
                    <p className="text-xs text-fg-2">task type: {s.taskType}</p>
                  </div>
                  {s.wastePct >= 5 ? (
                    <Badge tone="warn">{s.wastePct}% wasted</Badge>
                  ) : (
                    <Badge>{s.wastePct}% wasted</Badge>
                  )}
                </header>
                <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-fg-2">Cost per completed task</dt>
                    <dd className="num mt-1 text-h5 font-medium">
                      {s.costPerCompletedTask === null ? '—' : usd(s.costPerCompletedTask)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-fg-2">Completed tasks</dt>
                    <dd className="num mt-1 text-h5 font-medium">{s.completedTasks}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-fg-2">p95 latency</dt>
                    <dd className="num mt-1 text-h5 font-medium">
                      {s.p95LatencyMs === null ? '—' : `${s.p95LatencyMs} ms`}
                    </dd>
                  </div>
                </dl>
                <div className="mt-4">
                  <p className="mb-1 text-xs text-fg-2">
                    Cost per completed task, against the priciest vendor
                  </p>
                  <div className="h-1.5 rounded-full bg-surface-2" aria-hidden>
                    <div
                      className="h-full rounded-full bg-series-1"
                      style={{ width: `${((s.costPerCompletedTask ?? 0) / maxCost) * 100}%` }}
                    />
                  </div>
                  <p className="num mt-2 text-xs text-fg-2">
                    {s.paidCalls} paid calls · {usd(s.spend)} spent · {usd(s.wasted)} wasted on{' '}
                    {s.failedCalls} failed {s.failedCalls === 1 ? 'call' : 'calls'}
                  </p>
                </div>
                {s.cheaperOption ? (
                  <p className="mt-4 flex items-start gap-2 rounded-xl bg-wax/12 px-3 py-2 text-sm">
                    <Sparkles className="mt-0.5 size-4 shrink-0 text-wax-deep" aria-hidden />
                    <span>
                      Cheaper option: <strong className="font-medium">{s.cheaperOption.vendorId}</strong>{' '}
                      completes the same task {s.cheaperOption.savingsPct}% cheaper (
                      {usd(s.cheaperOption.costPerCompletedTask)} per task).
                    </span>
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader
          title="Blocked payment requests"
          subtitle="402 challenges that did not match the registry. Nothing was signed."
        />
        {blocked.length === 0 ? (
          <EmptyState title="No blocked payment requests">
            If an agent is pointed at an endpoint whose payment request names a different payee, mint or
            price, it shows up here.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line/70">
            {blocked.map((c) => (
              <li key={c.id} className="flex gap-3 px-5 py-3">
                <Ban className="mt-0.5 size-4 shrink-0 text-sever" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone="sever">{c.verdict}</Badge>
                    <span className="font-medium">{c.agentId}</span>
                    <span className="text-fg-2">asked to pay “{c.vendorId}” at</span>
                    <span className="font-mono text-xs">{c.endpoint}</span>
                  </p>
                  <p className="mt-1 text-sm">{c.reason}</p>
                  <p className="mt-1 flex flex-wrap gap-x-4 text-xs text-fg-2">
                    <span>
                      offered payee <Addr value={c.payeeOffered} />
                    </span>
                    <span>
                      registered payee <Addr value={c.payeeExpected} />
                    </span>
                    <span className="num">{clock(c.ts)}</span>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader title="Registry" subtitle="The only payees Tabula will open channels to." />
        <Table>
          <thead>
            <tr>
              <Th>Vendor</Th>
              <Th>Payee</Th>
              <Th>Price</Th>
              <Th>Program</Th>
              <Th>Endpoint</Th>
            </tr>
          </thead>
          <tbody>
            {data.vendors.map((v) => (
              <tr key={v.id}>
                <Td className="font-medium">
                  {v.name}
                  <span className="block text-xs text-fg-2">{v.id}</span>
                </Td>
                <Td>
                  <Addr value={v.payeePubkey} />
                </Td>
                <Td className="num">
                  {usd(v.unitPrice)} / {v.unitName}
                </Td>
                <Td>
                  <Addr value={v.programId} />
                </Td>
                <Td className="font-mono text-xs text-fg-2">{v.endpoint}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  )
}
