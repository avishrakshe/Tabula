'use client'

import { Check, CircleCheck, Copy, ExternalLink, OctagonX, Pause, ShieldX, TriangleAlert } from 'lucide-react'
import { type ButtonHTMLAttributes, type ReactNode, useState } from 'react'
import { shortAddr, usd } from '@/lib/format'
import type { ReconcileStatus } from '@/lib/types'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export function Card({
  children,
  className,
  as: As = 'section',
}: {
  children: ReactNode
  className?: string
  as?: 'section' | 'div' | 'article'
}) {
  return <As className={cx('rounded-2xl border border-line bg-surface', className)}>{children}</As>
}

export function CardHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div>
        <h2 className="text-h5 font-medium">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-fg-2">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  )
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-h3 font-medium tracking-tight">{title}</h1>
        {description ? <p className="mt-2 max-w-[70ch] text-[15px] text-fg-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

type Tone = 'neutral' | 'live' | 'matched' | 'sever' | 'warn'
const TONE: Record<Tone, string> = {
  neutral: 'border-line bg-surface-2 text-fg-2',
  live: 'border-wax/40 bg-wax/12 text-fg',
  matched: 'border-matched/40 bg-matched/10 text-matched',
  sever: 'border-sever/40 bg-sever/10 text-sever',
  warn: 'border-amber/40 bg-amber/10 text-amber',
}

export function Badge({
  tone = 'neutral',
  icon,
  children,
}: {
  tone?: Tone
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium',
        TONE[tone],
      )}
    >
      {icon}
      {children}
    </span>
  )
}

/** Live/healthy dot in the brand accent (not a status color). */
export function LiveDot({ on = true }: { on?: boolean }) {
  return (
    <span className="relative inline-flex size-2" aria-hidden>
      {on ? (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-wax opacity-60 motion-reduce:hidden" />
      ) : null}
      <span className={cx('relative inline-flex size-2 rounded-full', on ? 'bg-wax' : 'bg-gray-1')} />
    </span>
  )
}

export function VerdictBadge({ verdict }: { verdict: 'signed' | 'blocked' }) {
  return verdict === 'blocked' ? (
    <Badge tone="sever" icon={<ShieldX className="size-3" aria-hidden />}>
      Blocked
    </Badge>
  ) : (
    <Badge tone="neutral" icon={<Check className="size-3" aria-hidden />}>
      Signed
    </Badge>
  )
}

export function AgentStatusBadge({ status }: { status: 'active' | 'paused' | 'killed' }) {
  if (status === 'killed')
    return (
      <Badge tone="sever" icon={<OctagonX className="size-3" aria-hidden />}>
        Stopped
      </Badge>
    )
  if (status === 'paused')
    return (
      <Badge tone="warn" icon={<Pause className="size-3" aria-hidden />}>
        Paused
      </Badge>
    )
  // neutral pill: a coral tint reads too close to the red "Stopped" badge beside it
  return (
    <Badge tone="neutral" icon={<LiveDot />}>
      Active
    </Badge>
  )
}

export function ReconcileBadge({ status }: { status: ReconcileStatus }) {
  switch (status) {
    case 'MATCHED':
      return (
        <Badge tone="matched" icon={<CircleCheck className="size-3" aria-hidden />}>
          MATCHED
        </Badge>
      )
    case 'CHAIN_AHEAD':
      return (
        <Badge tone="sever" icon={<OctagonX className="size-3" aria-hidden />}>
          CHAIN AHEAD
        </Badge>
      )
    case 'LEDGER_AHEAD':
      return (
        <Badge tone="warn" icon={<TriangleAlert className="size-3" aria-hidden />}>
          LEDGER AHEAD
        </Badge>
      )
    default:
      return (
        <Badge tone="warn" icon={<TriangleAlert className="size-3" aria-hidden />}>
          REFUND PENDING
        </Badge>
      )
  }
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
const BTN: Record<ButtonVariant, string> = {
  primary: 'bg-wax text-ink hover:bg-wax-deep hover:text-paper',
  secondary: 'border border-line bg-surface text-fg hover:bg-surface-2',
  danger: 'border border-sever/50 bg-surface text-sever hover:bg-sever hover:text-paper',
  ghost: 'text-fg-2 hover:bg-surface-2 hover:text-fg',
}

export function Button({
  variant = 'secondary',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        BTN[variant],
        className,
      )}
      {...rest}
    />
  )
}

export function Money({
  micros,
  className,
}: {
  micros: number | string | null | undefined
  className?: string
}) {
  return <span className={cx('num', className)}>{usd(micros)}</span>
}

export function ExplorerLink({
  href,
  children,
  className,
}: {
  href: string | null | undefined
  children: ReactNode
  className?: string
}) {
  if (!href) return <span className={className}>{children}</span>
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cx(
        'inline-flex items-center gap-1 text-fg underline decoration-line underline-offset-4 hover:decoration-wax',
        className,
      )}
    >
      {children}
      <ExternalLink className="size-3 shrink-0 text-muted" aria-label="(opens Solana Explorer)" />
    </a>
  )
}

export function Addr({
  value,
  href,
  n = 4,
}: {
  value: string | null | undefined
  href?: string | null
  n?: number
}) {
  const [copied, setCopied] = useState(false)
  if (!value) return <span className="text-muted">—</span>
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[13px]">
      {href ? (
        <ExplorerLink href={href}>{shortAddr(value, n)}</ExplorerLink>
      ) : (
        <span title={value}>{shortAddr(value, n)}</span>
      )}
      <button
        type="button"
        className="rounded p-0.5 text-muted hover:text-fg"
        aria-label={`Copy ${value}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })
        }}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </span>
  )
}

export function Kpi({
  label,
  value,
  hint,
  accent,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  accent?: boolean
}) {
  return (
    <Card className="px-5 py-4">
      <p className="text-sm text-fg-2">{label}</p>
      <p className={cx('mt-2 text-[28px] font-medium leading-none tracking-tight', accent && 'text-fg')}>
        {value}
      </p>
      {hint ? <p className="mt-2 text-xs text-muted">{hint}</p> : null}
    </Card>
  )
}

/** Budget meter: brand accent until 80%, amber to 100%, sever when exhausted (with a word, never color alone). */
export function Meter({ used, limit, label }: { used: number; limit: number; label: string }) {
  const pct = limit > 0 ? Math.min(1, used / limit) : 0
  const tone = pct >= 1 ? 'bg-sever' : pct >= 0.8 ? 'bg-amber' : 'bg-wax'
  return (
    <div className="min-w-32">
      {/* biome-ignore lint/a11y/useSemanticElements: the native <meter> cannot carry the accent/amber/sever severity fill consistently across browsers */}
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
      >
        <div
          className={cx('h-full rounded-full', tone)}
          style={{ width: `${Math.max(pct * 100, used > 0 ? 2 : 0)}%` }}
        />
      </div>
      <p className="num mt-1 text-xs text-fg-2">
        {usd(used)} of {usd(limit)}
        {pct >= 1 ? ' · exhausted' : ''}
      </p>
    </div>
  )
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {children ? <p className="max-w-md text-sm text-fg-2">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cx('w-full border-collapse text-left text-sm', className)}>{children}</table>
    </div>
  )
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cx(
        'border-b border-line px-4 py-2.5 text-xs font-medium whitespace-nowrap text-fg-2',
        className,
      )}
    >
      {children}
    </th>
  )
}

export function Td({
  children,
  className,
  colSpan,
  title,
}: {
  children?: ReactNode
  className?: string
  colSpan?: number
  title?: string
}) {
  return (
    <td
      colSpan={colSpan}
      title={title}
      className={cx('border-b border-line/70 px-4 py-2.5 align-middle', className)}
    >
      {children}
    </td>
  )
}
