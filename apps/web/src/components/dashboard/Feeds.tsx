'use client'

import {
  Activity,
  Ban,
  CircleCheck,
  Coins,
  Hourglass,
  Landmark,
  Layers,
  OctagonX,
  Receipt,
  ShieldX,
  SlidersHorizontal,
  Wallet,
} from 'lucide-react'
import { useTabula } from '@/lib/data/provider'
import { clock, timeAgo, usd } from '@/lib/format'
import type { TimelineItem, VoucherRow } from '@/lib/types'
import { Badge, cx, EmptyState, ExplorerLink } from '../ui'

const OUTCOME: Record<string, { label: string; tone: 'neutral' | 'warn' }> = {
  ok: { label: 'delivered', tone: 'neutral' },
  error: { label: 'vendor error', tone: 'warn' },
  empty: { label: 'empty', tone: 'warn' },
  timeout: { label: 'timed out', tone: 'warn' },
}

export function VoucherFeed({
  vouchers,
  limit = 40,
  agentFilter,
}: {
  vouchers: VoucherRow[]
  limit?: number
  agentFilter?: string
}) {
  const { now } = useTabula()
  const rows = (agentFilter ? vouchers.filter((v) => v.agentId === agentFilter) : vouchers).slice(0, limit)
  if (rows.length === 0) {
    return (
      <EmptyState title="No vouchers yet">
        When an agent pays through the gateway, every voucher — signed or blocked — appears here as it
        happens.
      </EmptyState>
    )
  }
  return (
    <ol className="divide-y divide-line/70" aria-live="polite" aria-relevant="additions">
      {rows.map((v, i) => {
        const blocked = v.verdict === 'blocked'
        const outcome = v.responseStatus ? OUTCOME[v.responseStatus] : null
        return (
          <li key={v.id} className={cx('flex items-start gap-3 px-5 py-2.5', blocked && 'bg-sever/[0.06]')}>
            <span className="mt-1.5 flex size-2 shrink-0 items-center justify-center" aria-hidden>
              {blocked ? (
                <span className="size-2 rounded-full bg-sever" />
              ) : (
                <span className={cx('size-2 rounded-full', i < 3 ? 'bg-wax' : 'bg-gray-2')} />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="font-medium">{v.agentId}</span>
                <span className="text-fg-2">→ {v.vendorId}</span>
                {blocked ? (
                  <Badge tone="sever" icon={<ShieldX className="size-3" aria-hidden />}>
                    Blocked
                  </Badge>
                ) : outcome && outcome.tone === 'warn' ? (
                  <Badge tone="warn">{outcome.label}</Badge>
                ) : null}
              </p>
              {blocked && v.reason ? <p className="mt-0.5 text-sm text-fg">{v.reason}</p> : null}
              <p className="mt-0.5 text-xs text-muted">
                <span className="num">{clock(v.ts)}</span> · {v.taskId} · {timeAgo(v.ts, now)}
              </p>
            </div>
            <div className="text-right">
              <p
                className={cx(
                  'num text-sm font-medium',
                  blocked && 'text-fg-2 line-through decoration-sever/60',
                )}
              >
                {usd(v.delta)}
              </p>
              <p className="num text-xs text-muted">Σ {usd(v.cumulativeAmount)}</p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

const ICON: Record<string, typeof Activity> = {
  session_opened: Layers,
  session_closed: Layers,
  challenge_blocked: Ban,
  agent_killed: OctagonX,
  kill_step: Hourglass,
  sweep: Landmark,
  top_up: Wallet,
  faucet: Wallet,
  batch_anchored: Receipt,
  policy_changed: SlidersHorizontal,
  float_sized: Coins,
  task_completed: CircleCheck,
}

export function Timeline({
  items,
  limit = 30,
  filter,
}: {
  items: TimelineItem[]
  limit?: number
  filter?: (t: TimelineItem) => boolean
}) {
  const { now } = useTabula()
  const rows = (filter ? items.filter(filter) : items).slice(0, limit)
  if (rows.length === 0) {
    return (
      <EmptyState title="Nothing has happened yet">
        Channel opens, kills, sweeps and onchain receipts are logged here with explorer links.
      </EmptyState>
    )
  }
  return (
    <ol className="divide-y divide-line/70">
      {rows.map((t) => {
        const Icon = ICON[t.type] ?? Activity
        const severe = t.type === 'agent_killed' || t.type === 'challenge_blocked'
        return (
          <li key={t.key} className="flex gap-3 px-5 py-3">
            <Icon className={cx('mt-0.5 size-4 shrink-0', severe ? 'text-sever' : 'text-fg-2')} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm">{t.message}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                <span className="num">{clock(t.ts)}</span>
                <span>{timeAgo(t.ts, now)}</span>
                {t.explorerUrl ? (
                  <ExplorerLink href={t.explorerUrl} className="text-xs">
                    {t.txSignature ? `tx ${t.txSignature.slice(0, 8)}…` : 'view onchain'}
                  </ExplorerLink>
                ) : null}
              </p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
