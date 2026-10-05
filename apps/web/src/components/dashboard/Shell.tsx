'use client'

import {
  Bot,
  Layers,
  LayoutDashboard,
  Moon,
  Pause,
  Play,
  Plug,
  Receipt,
  RotateCcw,
  Scale,
  SlidersHorizontal,
  Store,
  Sun,
  Zap,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { type ReactNode, useEffect, useState } from 'react'
import { useTabula } from '@/lib/data/provider'
import { duration } from '@/lib/format'
import { LogoMark, Wordmark } from '../site/Logo'
import { Button, cx, LiveDot } from '../ui'

const NAV = [
  { href: '/app', label: 'Overview', icon: LayoutDashboard },
  { href: '/app/agents', label: 'Agents', icon: Bot },
  { href: '/app/channels', label: 'Channels & float', icon: Layers },
  { href: '/app/ledger', label: 'Ledger', icon: Receipt },
  { href: '/app/reconciliation', label: 'Reconciliation', icon: Scale },
  { href: '/app/vendors', label: 'Vendors', icon: Store },
  { href: '/app/policies', label: 'Policies', icon: SlidersHorizontal },
]

/** Overview matches only itself; every other section also covers its detail pages (/app/agents/<id>). */
const isActive = (pathname: string, href: string) =>
  href === '/app' ? pathname === '/app' : pathname === href || pathname.startsWith(`${href}/`)

function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null)
  useEffect(() => {
    // ?theme=dark|light shows a theme without remembering it (links, screenshots)
    const asked = new URLSearchParams(window.location.search).get('theme')
    if (asked === 'dark' || asked === 'light') {
      document.documentElement.dataset.theme = asked
      setTheme(asked)
      return
    }
    try {
      const saved = localStorage.getItem('tabula.theme') as 'light' | 'dark' | null
      if (saved) {
        document.documentElement.dataset.theme = saved
        setTheme(saved)
      } else {
        setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      }
    } catch {
      setTheme('light')
    }
  }, [])
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      aria-label={`Switch to ${next} mode`}
      className="rounded-full p-2 text-fg-2 hover:bg-surface-2 hover:text-fg"
      onClick={() => {
        document.documentElement.dataset.theme = next
        try {
          localStorage.setItem('tabula.theme', next)
        } catch {
          // ignore
        }
        setTheme(next)
      }}
    >
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  )
}

function ConnectionPanel({ onClose }: { onClose: () => void }) {
  const { settings, setSettings } = useTabula()
  const [url, setUrl] = useState(settings.url)
  const [token, setToken] = useState(settings.token)
  return (
    <form
      className="absolute top-12 right-0 z-30 w-[340px] rounded-2xl border border-line bg-surface p-4 shadow-xl"
      onSubmit={(e) => {
        e.preventDefault()
        setSettings({ url: url.replace(/\/$/, ''), token })
        onClose()
      }}
    >
      <p className="text-sm font-medium">Connect a gateway</p>
      <p className="mt-1 text-xs text-fg-2">
        Run <code className="font-mono">pnpm demo --hold</code> locally, then connect to watch it live.
      </p>
      <label className="mt-3 block text-xs text-fg-2" htmlFor="gw-url">
        Gateway URL
      </label>
      <input
        id="gw-url"
        className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <label className="mt-3 block text-xs text-fg-2" htmlFor="gw-token">
        Admin token
      </label>
      <input
        id="gw-token"
        type="password"
        className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm"
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" type="submit">
          Connect
        </Button>
      </div>
    </form>
  )
}

const CLUSTER_LABEL: Record<string, string> = {
  devnet: 'Solana devnet',
  sandbox: 'the Solana Payment Sandbox',
  localnet: 'a local validator',
}
const clusterLabel = (c: string | null | undefined) => (c ? (CLUSTER_LABEL[c] ?? c) : 'Solana')

/** The hosted site's live demo: start a run on devnet, or follow the one in progress. */
function LiveRunControl() {
  const { hosted, source, now } = useTabula()
  if (!hosted) return null
  const run = hosted.run
  if (source === 'hosted' && run?.status === 'running') {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-wax/40 bg-surface px-3 py-1.5 text-xs">
        <LiveDot /> Live run #{run.id} ·{' '}
        <span className="num">{duration(Math.max(0, now - run.startedAt))}</span>
      </span>
    )
  }
  const joining = run?.status === 'running'
  return (
    <Button
      variant="primary"
      className="px-3 py-1.5 text-xs"
      disabled={hosted.starting || !hosted.available}
      title={hosted.available ? undefined : (hosted.reason ?? undefined)}
      onClick={() => void hosted.start()}
    >
      <Zap className="size-3.5" aria-hidden />
      {hosted.starting
        ? 'Starting…'
        : joining
          ? 'Watch the live run'
          : hosted.available
            ? `Run it live on ${hosted.cluster ?? 'devnet'}`
            : 'Live run unavailable'}
    </Button>
  )
}

function StatusBar() {
  const { mode, source, replay, settings, error, connect, showReplay, hosted } = useTabula()
  const [open, setOpen] = useState(false)
  return (
    <div className="relative flex flex-wrap items-center gap-3">
      {mode === 'live' ? (
        <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs">
          <LiveDot /> Live ·{' '}
          {source === 'hosted'
            ? `ledger on ${clusterLabel(hosted?.cluster)}`
            : settings.url.replace(/^https?:\/\//, '')}
          {error ? <span className="text-amber">· {error}</span> : null}
        </span>
      ) : null}
      {mode === 'replay' && error ? <span className="text-xs text-amber">{error}</span> : null}
      <LiveRunControl />
      {mode === 'connecting' ? <span className="text-xs text-fg-2">Connecting…</span> : null}
      {mode === 'error' ? <span className="text-xs text-sever">{error}</span> : null}
      {replay ? (
        <div className="flex flex-wrap items-center gap-2 rounded-full border border-line bg-surface px-2 py-1 text-xs">
          <span className="px-1 font-medium">Recorded run</span>
          <button
            type="button"
            className="rounded-full p-1.5 hover:bg-surface-2"
            aria-label={replay.playing ? 'Pause replay' : 'Play replay'}
            onClick={() => (replay.playing ? replay.pause() : replay.play())}
          >
            {replay.playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </button>
          <input
            type="range"
            min={0}
            max={replay.duration}
            value={replay.t}
            onChange={(e) => replay.seek(Number(e.target.value))}
            aria-label="Replay position"
            className="w-36 accent-[var(--color-wax)]"
          />
          <span className="num w-24 text-fg-2">
            {duration(replay.t)} / {duration(replay.duration)}
          </span>
          {[1, 4, 16].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => replay.setSpeed(s)}
              className={cx(
                'rounded-full px-2 py-1',
                replay.speed === s ? 'bg-wax text-ink' : 'text-fg-2 hover:bg-surface-2',
              )}
              aria-pressed={replay.speed === s}
            >
              {s}×
            </button>
          ))}
          <button
            type="button"
            className="rounded-full p-1.5 hover:bg-surface-2"
            aria-label="Restart replay"
            onClick={() => {
              replay.seek(replay.start)
              replay.play()
            }}
          >
            <RotateCcw className="size-3.5" />
          </button>
        </div>
      ) : null}
      <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => setOpen((v) => !v)}>
        <Plug className="size-3.5" />{' '}
        {source === 'gateway' && mode === 'live' ? 'Gateway' : 'Connect gateway'}
      </Button>
      {mode === 'live' ? (
        <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={showReplay}>
          View recorded run
        </Button>
      ) : mode === 'replay' ? (
        <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={connect}>
          {hosted ? 'Live ledger' : 'Retry live'}
        </Button>
      ) : null}
      {open ? <ConnectionPanel onClose={() => setOpen(false)} /> : null}
    </div>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { replay, mode, source, hosted } = useTabula()
  return (
    <div className="min-h-screen bg-bg text-fg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-full focus:bg-wax focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <div className="mx-auto flex max-w-[1440px]">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line px-4 py-6 md:flex">
          <Link href="/" className="px-2 text-h5" aria-label="Tabula home">
            <Wordmark markClassName="h-5 w-auto" />
          </Link>
          <p className="mt-1 px-2 text-xs text-fg-2">Every agent payment, accounted for.</p>
          <nav className="mt-8 flex flex-col gap-0.5" aria-label="Dashboard">
            {NAV.map(({ href, label, icon: Icon }) => {
              const active = isActive(pathname, href)
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm',
                    active
                      ? 'bg-surface font-medium text-fg shadow-[inset_0_0_0_1px_var(--tb-line)]'
                      : 'text-fg-2 hover:bg-surface hover:text-fg',
                  )}
                >
                  <Icon className={cx('size-4', active ? 'text-wax' : '')} aria-hidden />
                  {label}
                </Link>
              )
            })}
          </nav>
          <div className="mt-auto px-2 text-xs text-muted">
            {replay
              ? `Recorded ${new Date(replay.recordedAt).toLocaleString()} on ${clusterLabel(replay.cluster)}`
              : mode === 'live'
                ? source === 'hosted'
                  ? `Live ledger on ${clusterLabel(hosted?.cluster)}, test USDC only`
                  : 'Live gateway'
                : ''}
          </div>
        </aside>
        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-bg/90 px-4 py-3 backdrop-blur md:px-8">
            <div className="flex w-full min-w-0 items-center gap-3 md:hidden">
              <Link href="/" aria-label="Tabula home" className="shrink-0 rounded-lg p-1">
                <LogoMark className="h-5 w-auto" />
              </Link>
              <nav className="flex min-w-0 gap-1 overflow-x-auto" aria-label="Dashboard (mobile)">
                {NAV.map(({ href, label }) => {
                  const active = isActive(pathname, href)
                  return (
                    <Link
                      key={href}
                      href={href}
                      aria-current={active ? 'page' : undefined}
                      className={cx(
                        'whitespace-nowrap rounded-full px-3 py-1 text-xs',
                        active
                          ? 'bg-surface font-medium shadow-[inset_0_0_0_1px_var(--tb-line)]'
                          : 'text-fg-2',
                      )}
                    >
                      {label}
                    </Link>
                  )
                })}
              </nav>
            </div>
            <StatusBar />
            <ThemeToggle />
          </header>
          <main id="main" className="px-4 py-6 md:px-8 md:py-8">
            {children}
          </main>
        </div>
      </div>
    </div>
  )
}
