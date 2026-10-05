'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { LineChart } from '@/components/charts/LineChart'
import { Timeline, VoucherFeed } from '@/components/dashboard/Feeds'
import { Card, CardHeader, Kpi, PageHeader } from '@/components/ui'
import { useTabula } from '@/lib/data/provider'
import { clock, usd, usdCompact } from '@/lib/format'
import { cumulativeSpend } from '@/lib/series'

export default function OverviewPage() {
  const { data, mode, source, hosted } = useTabula()
  const o = data.overview
  // the hosted ledger holds every run since launch: chart the latest one, not days of flat line
  const run = source === 'hosted' ? hosted?.run : null
  const series = useMemo(() => {
    const agentIds = data.agents.map((a) => a.id)
    const labels = Object.fromEntries(data.agents.map((a) => [a.id, a.id]))
    const vouchers = run ? data.vouchers.filter((v) => v.ts >= run.startedAt) : data.vouchers
    return cumulativeSpend(vouchers, agentIds, labels)
  }, [data.vouchers, data.agents, run])
  const blocked = data.vouchers.filter((v) => v.verdict === 'blocked').length

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          o
            ? `${o.activeAgents} of ${o.totalAgents} agents active, ${o.openChannels === 0 ? 'no channels open yet' : `paying through ${o.openChannels} open channel${o.openChannels === 1 ? '' : 's'}`}. Treasury vault ${o.vaultBalance ? usdCompact(o.vaultBalance) : '—'}.`
            : mode === 'connecting'
              ? 'Connecting…'
              : 'Waiting for data.'
        }
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi
          label="Spend today"
          value={usd(o?.spendToday ?? 0)}
          hint={`${o?.vouchersToday ?? 0} vouchers signed`}
        />
        <Kpi
          label="Spend this hour"
          value={usd(o?.spendThisHour ?? 0)}
          hint={`${blocked} blocked before signing`}
        />
        <Kpi
          label="Active agents"
          value={`${o?.activeAgents ?? 0} / ${o?.totalAgents ?? 0}`}
          hint="stopped agents sign nothing"
        />
        <Kpi
          label="Escrow tied up"
          value={usd(o?.escrowTiedUp ?? 0)}
          hint={`${o?.openChannels ?? 0} open channels`}
        />
        <Kpi
          label="Reclaimed this week"
          value={usd((o?.escrowReclaimedThisWeek ?? 0) + 0)}
          hint={`${usd(o?.sweptToVaultThisWeek ?? 0)} swept to the vault`}
        />
      </div>

      <Card className="mt-6">
        <CardHeader
          title={run ? `Cumulative spend by agent, live run #${run.id}` : 'Cumulative spend by agent'}
          subtitle="Signed vouchers only. Blocked vouchers were never signed and cost nothing."
        />
        <div className="px-5 py-4">
          <LineChart
            series={series}
            yFormat={(v) => usd(Math.round(v))}
            xFormat={(x) => clock(x)}
            ariaLabel="Cumulative signed spend per agent over time"
            emptyText="Spend appears once agents start paying."
          />
        </div>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.25fr_1fr]">
        <Card>
          <CardHeader
            title="Live vouchers"
            subtitle="Every voucher is checked against policy before it is signed."
            actions={
              <Link href="/app/ledger" className="text-sm text-fg-2 underline-offset-4 hover:underline">
                Full ledger
              </Link>
            }
          />
          <div className="max-h-[560px] overflow-y-auto">
            <VoucherFeed vouchers={data.vouchers} limit={60} />
          </div>
        </Card>
        <Card>
          <CardHeader
            title="Onchain activity"
            subtitle="Channel opens and closes, kills, sweeps and ledger receipts."
          />
          <div className="max-h-[560px] overflow-y-auto">
            <Timeline
              items={data.timeline}
              limit={40}
              filter={(t) => t.type !== 'float_sized' && t.type !== 'task_completed'}
            />
          </div>
        </Card>
      </div>
    </>
  )
}
