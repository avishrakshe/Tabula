'use client'

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type BatchVerification, type DashboardData, EMPTY_DATA } from '../types'
import {
  type DemoRun,
  type DemoStatus,
  demoStatus,
  type FeedCursor,
  fetchFeed,
  GatewayClient,
  type GatewaySettings,
  HOSTED,
  LOADERS,
  REFRESH_ON,
  startDemoRun,
  tickDemoRun,
} from './live'
import { fromStream, mergeTimeline, mergeVouchers, type StreamEvent, voucherFromEvent } from './normalize'
import { loadReplay, type ReplayFile, recordedNow, stateAt } from './replay'

export type Mode = 'connecting' | 'live' | 'replay' | 'error'

/**
 * Where the dashboard reads from: the recorded run, a gateway the viewer runs (`pnpm demo --hold`, streamed
 * over SSE), or the hosted site's own ledger on devnet (polled: a serverless function can't hold a stream).
 */
export type Source = 'replay' | 'gateway' | 'hosted'

export interface ReplayControls {
  t: number
  duration: number
  playing: boolean
  speed: number
  recordedAt: string
  cluster: string
  play(): void
  pause(): void
  seek(t: number): void
  setSpeed(s: number): void
  batchRows(id: number): Record<string, unknown>[] | null
  verification(id: number): BatchVerification | null
}

/** The live demo on the hosted site: whether a run can start, and the latest one. */
export interface HostedDemo {
  available: boolean
  /** Why a run can't start now (funds being topped up, rate limits), when it can't. */
  reason: string | null
  cluster: string | null
  run: DemoRun | null
  starting: boolean
  /** Starts a run (or joins the one in progress) and switches to the live ledger. */
  start(): Promise<void>
}

export interface Actions {
  kill(agentId: string, reason?: string): Promise<void>
  revive(agentId: string): Promise<void>
  sweepIdle(idleSeconds?: number): Promise<{ reclaimed: string }>
  anchor(): Promise<void>
  verifyBatch(id: number): Promise<BatchVerification>
  batchRows(id: number): Promise<Record<string, unknown>[]>
  savePolicy(
    scope: 'global' | 'agent' | 'vendor',
    scopeId: string | null,
    rules: Record<string, unknown>,
  ): Promise<number>
  refresh(): Promise<void>
}

interface TabulaContext {
  mode: Mode
  source: Source | null
  data: DashboardData
  settings: GatewaySettings
  setSettings(s: GatewaySettings): void
  connect(): void
  showReplay(): void
  actions: Actions
  /** Whether kill switches, sweeps and policy edits work here (only on a gateway of the viewer's own). */
  canAct: boolean
  /** Why they don't, for the disabled controls' tooltips. */
  actHint: string | undefined
  replay: ReplayControls | null
  /** Null where the site has no live ledger (a static deployment, or a local gateway in use). */
  hosted: HostedDemo | null
  /** "Now" for relative times: the wall clock live, the recording's clock in replay. */
  now: number
  exportUrl: string | null
  error: string | null
  lastEventAt: number | null
}

const Ctx = createContext<TabulaContext | null>(null)

const DEFAULTS: GatewaySettings = {
  url: process.env.NEXT_PUBLIC_TABULA_GATEWAY_URL ?? 'http://127.0.0.1:4800',
  token: process.env.NEXT_PUBLIC_TABULA_ADMIN_TOKEN ?? 'tabula-demo-admin',
}
const STORAGE_KEY = 'tabula.gateway'

/** Hosted polling: quick while a run is in progress, slow otherwise; the chain-reading views less often. */
const POLL_RUNNING_MS = 2_500
const POLL_IDLE_MS = 30_000
const FULL_RUNNING_MS = 20_000
const FULL_IDLE_MS = 120_000
const STATUS_MS = 60_000

/** The viewer's saved gateway, if they ever connected one. */
function savedSettings(): GatewaySettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<GatewaySettings>) }
  } catch {
    // storage unavailable: defaults
  }
  return null
}

/**
 * Probe for a gateway of the viewer's own only where one can exist: on localhost, when the build names a
 * gateway, or once the viewer has connected one. Everyone else reads the hosted site's ledger.
 */
function shouldTryGateway(saved: GatewaySettings | null): boolean {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
  return local || !!process.env.NEXT_PUBLIC_TABULA_GATEWAY_URL || saved !== null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function mergePatch(prev: DashboardData, patch: Partial<DashboardData>): DashboardData {
  return {
    ...prev,
    ...patch,
    // a quick poll's agents come without their onchain allowance: keep the last one read
    agents: patch.agents
      ? patch.agents.map((a) =>
          a.allowance !== undefined
            ? a
            : { ...a, allowance: prev.agents.find((p) => p.id === a.id)?.allowance ?? null },
        )
      : prev.agents,
    vouchers: patch.vouchers ? mergeVouchers(prev.vouchers, patch.vouchers) : prev.vouchers,
    timeline: patch.timeline ? mergeTimeline(prev.timeline, patch.timeline) : prev.timeline,
  }
}

export function TabulaProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<GatewaySettings>(DEFAULTS)
  const [mode, setMode] = useState<Mode>('connecting')
  const [data, setData] = useState<DashboardData>(EMPTY_DATA)
  const [error, setError] = useState<string | null>(null)
  const [lastEventAt, setLastEventAt] = useState<number | null>(null)
  const [tick, setTick] = useState(() => Date.now())
  const [attempt, setAttempt] = useState(0)
  // null until the first effect decides where to read from
  const [source, setSource] = useState<Source | null>(null)

  // hosted live demo
  const [status, setStatus] = useState<DemoStatus | null>(null)
  const [run, setRun] = useState<DemoRun | null>(null)
  const [starting, setStarting] = useState(false)
  const pollNow = useRef<() => void>(() => {})

  // replay state
  const [file, setFile] = useState<ReplayFile | null>(null)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(4)

  const client = useMemo(() => new GatewayClient(source === 'hosted' ? HOSTED : settings), [settings, source])

  // ?replay opens the recorded run; ?replay&t=59 opens it paused at 0:59 (deep links, screenshots)
  const startAt = useRef<number | null>(null)
  useEffect(() => {
    const saved = savedSettings()
    if (saved) setSettingsState(saved)
    const q = new URLSearchParams(window.location.search)
    const at = Number(q.get('t'))
    if (q.has('t') && Number.isFinite(at)) startAt.current = at * 1000
    const own = shouldTryGateway(saved)
    if (q.has('replay')) {
      setSource('replay')
      // offer the live run next to the recording when the site has one
      if (!own) void demoStatus().then(setStatus)
    } else {
      setSource(own ? 'gateway' : 'hosted')
    }
  }, [])

  // relative-time ticker
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // ---- a gateway of the viewer's own (SSE) ------------------------------------------------
  const pending = useRef(new Set<string>())
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(
    async (keys: string[]) => {
      const parts = await Promise.allSettled(keys.map((k) => LOADERS[k]!(client)))
      setData((prev) => {
        let next = prev
        for (const p of parts) if (p.status === 'fulfilled') next = mergePatch(next, p.value)
        return next
      })
    },
    [client],
  )

  const schedule = useCallback(
    (keys: string[]) => {
      for (const k of keys) pending.current.add(k)
      if (flushTimer.current) return
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null
        const ks = [...pending.current]
        pending.current.clear()
        void load(ks)
      }, 600)
    },
    [load],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: bumping `attempt` reconnects on demand
  useEffect(() => {
    if (source !== 'gateway') return
    let cancelled = false
    let es: EventSource | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    setMode('connecting')
    ;(async () => {
      const ok = await client.health()
      if (cancelled) return
      if (!ok) {
        // no gateway here: the site's own live ledger if it has one, else the recorded run
        const st = await demoStatus()
        if (cancelled) return
        setStatus(st)
        setSource(st.live ? 'hosted' : 'replay')
        return
      }
      setMode('live')
      setError(null)
      await load(Object.keys(LOADERS))
      es = new EventSource(client.streamUrl())
      const onEvent = (msg: MessageEvent) => {
        const e = JSON.parse(msg.data) as StreamEvent
        setLastEventAt(Date.now())
        if (e.type === 'voucher') {
          const row = voucherFromEvent(e)
          if (row) setData((prev) => ({ ...prev, vouchers: mergeVouchers(prev.vouchers, [row]) }))
        } else {
          setData((prev) => ({ ...prev, timeline: mergeTimeline(prev.timeline, [fromStream(e)]) }))
        }
        schedule(REFRESH_ON[e.type] ?? [])
      }
      for (const type of [
        'voucher',
        ...Object.keys(REFRESH_ON),
        'kill_step',
        'float_sized',
        'faucet',
        'challenge_ok',
        'reconciled',
      ]) {
        es.addEventListener(type, onEvent as EventListener)
      }
      es.onerror = () => setError('Lost the live stream; retrying…')
      es.onopen = () => setError(null)
      // slower-moving views (onchain reads) refresh on a timer
      poll = setInterval(() => schedule(['reconcile', 'float', 'agents', 'overview']), 15_000)
    })()
    return () => {
      cancelled = true
      es?.close()
      if (poll) clearInterval(poll)
    }
  }, [client, source, load, schedule, attempt])

  // ---- the hosted site's ledger (polled) ----------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: bumping `attempt` reconnects on demand
  useEffect(() => {
    if (source !== 'hosted') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let cursor: FeedCursor = { v: 0, e: 0 }
    let polls = 0
    let failures = 0
    let lastFull = 0
    let lastStatus = 0
    let wasRunning = false
    let inFlight = false
    let again = false
    setMode('connecting')
    setData(EMPTY_DATA)

    const poll = async () => {
      if (timer) clearTimeout(timer)
      timer = null
      if (inFlight) {
        again = true
        return
      }
      inFlight = true
      const now = Date.now()
      // the first poll skips the chain reads so the page fills fast; the second, right after, has them
      const full =
        polls > 0 && (lastFull === 0 || now - lastFull > (wasRunning ? FULL_RUNNING_MS : FULL_IDLE_MS))
      let running = wasRunning
      try {
        const [feed, st] = await Promise.all([
          fetchFeed({ full, after: cursor }),
          polls === 0 || now - lastStatus > STATUS_MS ? demoStatus() : Promise.resolve(null),
        ])
        if (cancelled) return
        if (st) {
          lastStatus = now
          setStatus(st)
          if (!st.live && polls === 0) {
            setSource('replay') // the site answers but has no live ledger (not set up)
            return
          }
        }
        polls++
        failures = 0
        if (full) lastFull = now
        cursor = feed.cursor
        setData((prev) => mergePatch(prev, feed.patch))
        setRun(feed.run)
        running = feed.run?.status === 'running'
        if (wasRunning && !running) lastFull = 0 // the run just finished: read its receipts in full
        wasRunning = running
        setMode('live')
        setError(null)
        setLastEventAt(Date.now())
      } catch {
        if (cancelled) return
        if (polls === 0) {
          setSource('replay') // never had a first view: the recorded run instead
          return
        }
        failures++
        setError('Lost the live ledger; retrying…')
      } finally {
        inFlight = false
      }
      const wait =
        failures > 0
          ? Math.min(5_000 * failures, POLL_IDLE_MS)
          : again || lastFull === 0
            ? 0 // a poll was asked for meanwhile, or the chain reads are due now
            : document.hidden
              ? POLL_IDLE_MS * 2
              : running
                ? POLL_RUNNING_MS
                : POLL_IDLE_MS
      again = false
      timer = setTimeout(() => void poll(), wait)
    }

    pollNow.current = () => void poll()
    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      pollNow.current = () => {}
    }
  }, [source, attempt])

  // While a run is in progress, this viewer helps drive it. Every viewer may call tick: the run's lease
  // lets one tick work at a time, and the others return at once. Cron drives a run nobody is watching.
  const activeRunId = source === 'hosted' && run?.status === 'running' ? run.id : null
  useEffect(() => {
    if (activeRunId === null) return
    let cancelled = false
    ;(async () => {
      while (!cancelled) {
        const began = Date.now()
        const r = await tickDemoRun(activeRunId).catch(() => null)
        if (cancelled) return
        if (r) {
          setRun(r)
          pollNow.current()
          if (r.status !== 'running') return
        }
        // a quick answer means another viewer's tick holds the lease
        await sleep(!r ? 5_000 : Date.now() - began < 1_000 ? 3_000 : 500)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeRunId])

  // ---- replay mode ----------------------------------------------------------------------
  useEffect(() => {
    if (source !== 'replay') return
    let cancelled = false
    setMode('connecting')
    loadReplay()
      .then((f) => {
        if (cancelled) return
        setFile(f)
        const at = startAt.current
        startAt.current = null
        setT(at === null ? 0 : Math.max(0, Math.min(f.meta.durationMs, at)))
        setPlaying(at === null)
        setMode('replay')
      })
      .catch((err: Error) => {
        if (cancelled) return
        setError(err.message)
        setMode('error')
      })
    return () => {
      cancelled = true
    }
  }, [source])

  useEffect(() => {
    if (mode !== 'replay' || !file || !playing) return
    let last = performance.now()
    const id = setInterval(() => {
      const now = performance.now()
      const dt = (now - last) * speed
      last = now
      setT((prev) => {
        const next = Math.min(file.meta.durationMs, prev + dt)
        if (next >= file.meta.durationMs) setPlaying(false)
        return next
      })
    }, 200)
    return () => clearInterval(id)
  }, [mode, file, playing, speed])

  const replayData = useMemo(() => (mode === 'replay' && file ? stateAt(file, t) : null), [mode, file, t])

  const replay: ReplayControls | null = useMemo(() => {
    if (mode !== 'replay' || !file) return null
    return {
      t,
      duration: file.meta.durationMs,
      playing,
      speed,
      recordedAt: file.meta.recordedAt,
      cluster: file.meta.cluster,
      play: () => {
        if (t >= file.meta.durationMs) setT(0)
        setPlaying(true)
      },
      pause: () => setPlaying(false),
      seek: (v) => setT(Math.max(0, Math.min(file.meta.durationMs, v))),
      setSpeed,
      batchRows: (id) => file.final.batchDetails[id]?.rows ?? null,
      verification: (id) => file.final.batchDetails[id]?.verification ?? null,
    }
  }, [mode, file, t, playing, speed])

  // ---- hosted demo ------------------------------------------------------------------------
  const start = useCallback(async () => {
    setStarting(true)
    setError(null)
    try {
      const r = await startDemoRun()
      setRun(r)
      setStatus((s) => (s ? { ...s, activeId: r.id, latest: r } : s))
      if (source === 'hosted') pollNow.current()
      else setSource('hosted')
    } catch (err) {
      setError((err as Error).message)
      void demoStatus().then(setStatus)
    } finally {
      setStarting(false)
    }
  }, [source])

  const hosted: HostedDemo | null = useMemo(() => {
    if (!status?.live) return null
    return {
      available: status.available,
      reason: status.reason,
      cluster: status.cluster ?? null,
      run: run ?? status.latest,
      starting,
      start,
    }
  }, [status, run, starting, start])

  // ---- actions --------------------------------------------------------------------------
  const live = mode === 'live'
  const own = live && source === 'gateway'
  const actHint = own
    ? undefined
    : live
      ? 'Read-only on the hosted demo: run pnpm demo locally to use the controls'
      : 'Connect a live gateway to act'
  const actions: Actions = useMemo(() => {
    const readonly = () =>
      Promise.reject(
        new Error(
          live
            ? 'The hosted demo is read-only: kill switches, sweeps and policy edits stay with the operator. Run pnpm demo locally to use them.'
            : 'This is a recorded run. Connect a live gateway to take actions.',
        ),
      )
    return {
      kill: async (agentId, reason) => {
        if (!own) return readonly()
        await client.post('/v1/kill', { agentId, reason: reason ?? 'stopped from the dashboard' })
        await load(['agents', 'overview', 'channels', 'float', 'timeline'])
      },
      revive: async (agentId) => {
        if (!own) return readonly()
        await client.post('/v1/revive', { agentId })
        await load(['agents', 'overview', 'timeline'])
      },
      sweepIdle: async (idleSeconds) => {
        if (!own) return readonly()
        const r = await client.post<{ reclaimed: string }>(
          '/v1/float/sweep',
          idleSeconds === undefined ? {} : { idleSeconds },
        )
        await load(['float', 'channels', 'overview', 'timeline', 'reconcile'])
        return r
      },
      anchor: async () => {
        if (!own) return readonly()
        await client.post('/v1/anchor')
        await load(['batches', 'vouchers', 'timeline'])
      },
      verifyBatch: async (id) => {
        if (live) return client.verifyBatch(id)
        const v = file?.final.batchDetails[id]?.verification
        if (!v) throw new Error(`batch ${id} was not part of the recording`)
        return v
      },
      batchRows: async (id) => {
        if (live) return (await client.batchRows(id)).rows
        const rows = file?.final.batchDetails[id]?.rows
        if (!rows) throw new Error(`batch ${id} was not part of the recording`)
        return rows
      },
      savePolicy: async (scope, scopeId, rules) => {
        if (!own) return readonly()
        const r = await client.put<{ version: number }>('/v1/policies', {
          scope,
          scopeId,
          rules,
          updatedBy: 'dashboard',
        })
        await load(['policies', 'timeline'])
        return r.version
      },
      refresh: async () => {
        if (own) await load(Object.keys(LOADERS))
        else if (live) pollNow.current()
      },
    }
  }, [client, live, own, load, file])

  const setSettings = useCallback((s: GatewaySettings) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    } catch {
      // ignore
    }
    setSettingsState(s)
    setData(EMPTY_DATA)
    setSource('gateway')
    setAttempt((a) => a + 1)
  }, [])

  const value: TabulaContext = {
    mode,
    source,
    data: replayData ?? data,
    settings,
    setSettings,
    connect: () => {
      setData(EMPTY_DATA)
      setSource(shouldTryGateway(savedSettings()) ? 'gateway' : 'hosted')
      setAttempt((a) => a + 1)
    },
    showReplay: () => setSource('replay'),
    actions,
    canAct: own,
    actHint,
    replay,
    hosted,
    now: replay && file ? recordedNow(file, replay.t) : tick,
    exportUrl: live ? client.exportUrl() : null,
    error,
    lastEventAt,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTabula(): TabulaContext {
  const v = useContext(Ctx)
  if (!v) throw new Error('useTabula must be used inside <TabulaProvider>')
  return v
}
