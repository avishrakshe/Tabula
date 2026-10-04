/** Micro-dollars -> "$1.23" (sub-cent precision only when present: "$0.0012"). */
export function usd(micros: number | string | bigint | null | undefined): string {
  if (micros === null || micros === undefined || micros === '') return '—'
  const n = typeof micros === 'bigint' ? Number(micros) : Number(micros)
  if (!Number.isFinite(n)) return '—'
  const neg = n < 0
  const abs = Math.abs(n)
  const dollars = abs / 1e6
  let s: string
  if (abs === 0) s = '0.00'
  else if (abs % 10_000 === 0) s = dollars.toFixed(2)
  else
    s = dollars
      .toFixed(6)
      .replace(/0+$/, '')
      .replace(/\.(\d)$/, '.$10')
  const [whole, frac] = s.split('.')
  const grouped = Number(whole).toLocaleString('en-US')
  return `${neg ? '−' : ''}$${grouped}${frac !== undefined ? `.${frac}` : ''}`
}

/** Compact dollars for stat tiles: $999.74, $12.9K. */
export function usdCompact(micros: number | string | null | undefined): string {
  if (micros === null || micros === undefined) return '—'
  const d = Number(micros) / 1e6
  if (Math.abs(d) >= 10_000) return `$${(d / 1000).toFixed(1)}K`
  if (Math.abs(d) >= 100)
    return `$${d.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
  return usd(micros)
}

export function shortAddr(addr: string | null | undefined, n = 4): string {
  if (!addr) return '—'
  return addr.length <= n * 2 + 1 ? addr : `${addr.slice(0, n)}…${addr.slice(-n)}`
}

export function timeAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}

export const RULE_LABEL: Record<string, string> = {
  VELOCITY: 'Velocity',
  DAILY_BUDGET: 'Daily budget',
  TASK_BUDGET: 'Task budget',
  UNIT_PRICE: 'Unit price',
  VENDOR_DENIED: 'Denied vendor',
  VENDOR_NOT_ALLOWED: 'Unapproved vendor',
  ANOMALY: 'Anomaly',
  GLOBAL_KILL: 'Kill switch',
  AGENT_KILLED: 'Agent stopped',
  AGENT_PAUSED: 'Agent paused',
  CHANNEL_DEPOSIT: 'Escrow used up',
  ONCHAIN_CEILING: 'Onchain ceiling',
  INVALID_REQUEST: 'Invalid request',
}
