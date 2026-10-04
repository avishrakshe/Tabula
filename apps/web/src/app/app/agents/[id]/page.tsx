'use client'

import { OctagonX } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { LineChart } from '@/components/charts/LineChart'
import { Timeline, VoucherFeed } from '@/components/dashboard/Feeds'
import {
  Addr,
  AgentStatusBadge,
  Button,
  Card,
  CardHeader,
  Kpi,
  PageHeader,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { useTabula } from '@/lib/data/provider'
import { clock, usd } from '@/lib/format'
import { colorFor, rollingSpend } from '@/lib/series'

function velocityLimit(
  rules: Record<string, unknown> | undefined,
): { max: number; windowSec: number } | null {
  const v = rules?.velocity as
    | { windowSec: number; maxUsd: number }
    | { windowSec: number; maxUsd: number }[]
    | undefined
  if (!v) return null
  const list = Array.isArray(v) ? v : [v]
  const sixty = list.find((x) => x.windowSec === 60) ?? list[0]
  return sixty ? { max: Math.round(sixty.maxUsd * 1e6), windowSec: sixty.windowSec } : null
}

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data, actions, canAct, actHint } = useTabula()
  const agent = data.agents.find((a) => a.id === id)
  const policy = data.policies.find((p) => p.scope === 'agent' && p.scopeId === id && p.active)
  const limit = velocityLimit(policy?.rules)
  const mine = useMemo(() => data.vouchers.filter((v) => v.agentId === id), [data.vouchers, id])
  const signed = mine.filter((v) => v.verdict === 'signed')
  const blocked = mine.filter((v) => v.verdict === 'blocked')
  const agentIds = useMemo(() => data.agents.map((a) => a.id), [data.agents])
  const windowSec = limit?.windowSec ?? 60

  const series = useMemo(
    () => [
      {
        id: id,
        label: `${id}: spend in trailing ${windowSec}s`,
        color: colorFor(agentIds, id),
        points: rollingSpend(data.vouchers, id, windowSec * 1000),
      },
    ],
    [data.vouchers, id, windowSec, agentIds],
  )

  const tasks = useMemo(() => {
    const m = new Map<
      string,
      { task: string; calls: number; spend: number; wasted: number; blocked: number }
    >()
    for (const v of mine) {
      const t = m.get(v.taskId) ?? { task: v.taskId, calls: 0, spend: 0, wasted: 0, blocked: 0 }
      if (v.verdict === 'blocked') t.blocked++
      else {
        t.calls++
        t.spend += v.delta
        if (v.responseStatus && v.responseStatus !== 'ok') t.wasted += v.delta
      }
      m.set(v.taskId, t)
    }
    return [...m.values()].sort((a, b) => b.spend - a.spend)
  }, [mine])

  const [draft, setDraft] = useState('')
  const [policyMsg, setPolicyMsg] = useState<string | null>(null)
  // reset the editor only when the saved rules change, not on every data refresh
  const savedRules = JSON.stringify(policy?.rules ?? {}, null, 2)
  useEffect(() => {
    setDraft(savedRules)
  }, [savedRules])

  if (!agent) {
    return (
      <PageHeader
        title={id}
        description={
          <>
            Agent not found.{' '}
            <Link href="/app/agents" className="underline">
              Back to agents
            </Link>
          </>
        }
      />
    )
  }

  return (
    <>
      <PageHeader
        title={agent.id}
        description={`${agent.role} · ${agent.department}`}
        actions={
          <>
            <AgentStatusBadge status={agent.status} />
            {agent.status !== 'killed' ? (
              <Button
                variant="danger"
                disabled={!canAct}
                title={actHint}
                onClick={() => void actions.kill(agent.id)}
              >
                <OctagonX className="size-3.5" /> Stop agent
              </Button>
            ) : null}
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Signed spend"
          value={usd(signed.reduce((s, v) => s + v.delta, 0))}
          hint={`${signed.length} vouchers`}
        />
        <Kpi
          label="Blocked vouchers"
          value={String(blocked.length)}
          hint={blocked[0]?.reason ?? 'none so far'}
        />
        <Kpi
          label="Allowance left today"
          value={agent.allowance ? usd(agent.allowance.remaining) : '—'}
          hint={
            agent.allowance ? `of ${usd(agent.allowance.perPeriod)} per day, onchain` : 'no onchain ceiling'
          }
        />
        <Kpi
          label="Velocity limit"
          value={limit ? usd(limit.max) : 'none'}
          hint={limit ? `per ${limit.windowSec}s` : undefined}
        />
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Spend in the trailing window"
          subtitle="Exactly what the velocity rule measures. The first voucher that would cross the line is blocked unsigned."
        />
        <div className="px-5 py-4">
          <LineChart
            series={series}
            area
            yFormat={(v) => usd(Math.round(v))}
            xFormat={(x) => clock(x)}
            reference={
              limit
                ? { y: limit.max, label: `velocity limit ${usd(limit.max)} / ${limit.windowSec}s` }
                : undefined
            }
            ariaLabel={`${agent.id} signed spend in the trailing window over time`}
            emptyText="No signed vouchers yet."
          />
        </div>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Tasks"
            subtitle="Spend by task, including what was wasted on failed vendor calls."
          />
          <Table>
            <thead>
              <tr>
                <Th>Task</Th>
                <Th className="text-right">Paid calls</Th>
                <Th className="text-right">Spend</Th>
                <Th className="text-right">Wasted</Th>
                <Th className="text-right">Blocked</Th>
              </tr>
            </thead>
            <tbody>
              {tasks.slice(0, 15).map((t) => (
                <tr key={t.task}>
                  <Td className="font-mono text-xs">{t.task}</Td>
                  <Td className="num text-right">{t.calls}</Td>
                  <Td className="num text-right">{usd(t.spend)}</Td>
                  <Td className="num text-right">{usd(t.wasted)}</Td>
                  <Td className="num text-right">{t.blocked}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader
            title="Policy"
            subtitle={
              policy
                ? `Version ${policy.version}, updated by ${policy.updatedBy}. Combined with the global policy: the strictest limit wins.`
                : 'No agent policy: only the global policy applies.'
            }
            actions={
              <Button
                variant="primary"
                disabled={!canAct}
                title={actHint}
                onClick={async () => {
                  setPolicyMsg(null)
                  try {
                    const rules = JSON.parse(draft) as Record<string, unknown>
                    const v = await actions.savePolicy('agent', agent.id, rules)
                    setPolicyMsg(`Saved as version ${v}. The change is in the audit log.`)
                  } catch (err) {
                    setPolicyMsg((err as Error).message)
                  }
                }}
              >
                Save
              </Button>
            }
          />
          <div className="p-5">
            <label htmlFor="policy-json" className="sr-only">
              Policy JSON
            </label>
            <textarea
              id="policy-json"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              rows={12}
              className="w-full rounded-xl border border-line bg-bg p-3 font-mono text-[13px]"
            />
            {policyMsg ? <p className="mt-2 text-sm text-fg-2">{policyMsg}</p> : null}
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-fg-2">
              <dt>Wallet (payer)</dt>
              <dd>
                <Addr value={agent.payerPubkey} />
              </dd>
              <dt>Voucher key</dt>
              <dd>
                <Addr value={agent.voucherPubkey} />
              </dd>
              <dt>Allowance</dt>
              <dd>
                <Addr value={agent.allowance?.address} />
              </dd>
            </dl>
          </div>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Vouchers" />
          <div className="max-h-[480px] overflow-y-auto">
            <VoucherFeed vouchers={data.vouchers} agentFilter={agent.id} limit={80} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Timeline" subtitle="Every step, with explorer links." />
          <div className="max-h-[480px] overflow-y-auto">
            <Timeline items={data.timeline} filter={(t) => t.agentId === agent.id} limit={60} />
          </div>
        </Card>
      </div>
    </>
  )
}
