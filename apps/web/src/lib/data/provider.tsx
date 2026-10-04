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
import { GatewayClient, type GatewaySettings, LOADERS, REFRESH_ON } from './live'
import { fromStream, mergeTimeline, mergeVouchers, type StreamEvent, voucherFromEvent } from './normalize'
import { loadReplay, type ReplayFile, recordedNow, stateAt } from './replay'

export type Mode = 'connecting' | 'live' | 'replay' | 'error'

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
  data: DashboardData
  settings: GatewaySettings
  setSettings(s: GatewaySettings): void
  connect(): void
  showReplay(): void
  actions: Actions
  replay: ReplayControls | null
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

function loadSettings(): GatewaySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<GatewaySettings>) }
  } catch {
    // storage unavailable: defaults
  }
  return DEFAULTS
}

const readonlyError = () =>
  Promise.reject(new Error('This is a recorded run. Connect a live gateway to take actions.'))

export function TabulaProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<GatewaySettings>(DEFAULTS)
  const [mode, setMode] = useState<Mode>('connecting')
  const [data, setData] = useState<DashboardData>(EMPTY_DATA)
  const [error, setError] = useState<string | null>(null)
  const [lastEventAt, setLastEventAt] = useState<number | null>(null)
  const [tick, setTick] = useState(() => Date.now())
  const [attempt, setAttempt] = useState(0)
  const [forceReplay, setForceReplay] = useState(false)

  // replay state
  const [file, setFile] = useState<ReplayFile | null>(null)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(4)

  const client = useMemo(() => new GatewayClient(settings), [settings])

  // ?replay opens the recorded run; ?replay&t=59 opens it paused at 0:59 (deep links, screenshots)
  const startAt = useRef<number | null>(null)
  useEffect(() => {
    setSettingsState(loadSettings())
    const q = new URLSearchParams(window.location.search)
    if (q.has('replay')) setForceReplay(true)
    const at = Number(q.get('t'))
    if (q.has('t') && Number.isFinite(at)) startAt.current = at * 1000
  }, [])

  // relative-time ticker
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // ---- live mode ------------------------------------------------------------------------
  const pending = useRef(new Set<string>())
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(
    async (keys: string[]) => {
      const parts = await Promise.allSettled(keys.map((k) => LOADERS[k]!(client)))
      setData((prev) => {
        let next = prev
        for (const p of parts) {
          if (p.status !== 'fulfilled') continue
          const patch = p.value
          next = {
            ...next,
            ...patch,
            vouchers: patch.vouchers ? mergeVouchers(next.vouchers, patch.vouchers) : next.vouchers,
            timeline: patch.timeline ? mergeTimeline(next.timeline, patch.timeline) : next.timeline,
          }
        }
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
    if (forceReplay) return
    let cancelled = false
    let es: EventSource | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    setMode('connecting')
    ;(async () => {
      const ok = await client.health()
      if (cancelled) return
      if (!ok) {
        setForceReplay(true)
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
  }, [client, forceReplay, load, schedule, attempt])

  // ---- replay mode ----------------------------------------------------------------------
  useEffect(() => {
    if (!forceReplay) return
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
  }, [forceReplay])

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

  // ---- actions --------------------------------------------------------------------------
  const live = mode === 'live'
  const actions: Actions = useMemo(
    () => ({
      kill: async (agentId, reason) => {
        if (!live) return readonlyError()
        await client.post('/v1/kill', { agentId, reason: reason ?? 'stopped from the dashboard' })
        await load(['agents', 'overview', 'channels', 'float', 'timeline'])
      },
      revive: async (agentId) => {
        if (!live) return readonlyError()
        await client.post('/v1/revive', { agentId })
        await load(['agents', 'overview', 'timeline'])
      },
      sweepIdle: async (idleSeconds) => {
        if (!live) return readonlyError()
        const r = await client.post<{ reclaimed: string }>(
          '/v1/float/sweep',
          idleSeconds === undefined ? {} : { idleSeconds },
        )
        await load(['float', 'channels', 'overview', 'timeline', 'reconcile'])
        return r
      },
      anchor: async () => {
        if (!live) return readonlyError()
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
        if (!live) return readonlyError()
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
        if (live) await load(Object.keys(LOADERS))
      },
    }),
    [client, live, load, file],
  )

  const setSettings = useCallback((s: GatewaySettings) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    } catch {
      // ignore
    }
    setSettingsState(s)
    setData(EMPTY_DATA)
    setForceReplay(false)
    setAttempt((a) => a + 1)
  }, [])

  const value: TabulaContext = {
    mode,
    data: replayData ?? data,
    settings,
    setSettings,
    connect: () => {
      setData(EMPTY_DATA)
      setForceReplay(false)
      setAttempt((a) => a + 1)
    },
    showReplay: () => setForceReplay(true),
    actions,
    replay,
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
