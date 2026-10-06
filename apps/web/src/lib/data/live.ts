import type { BatchVerification, DashboardData } from '../types'
import { type AuditRow, fromAudit } from './normalize'

export interface GatewaySettings {
  url: string
  token: string
}

export class GatewayClient {
  constructor(readonly settings: GatewaySettings) {}

  async #req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.settings.url}${path}`, {
      method,
      headers: {
        // no token on the hosted demo: the site serves its public reads without one
        ...(this.settings.token ? { authorization: `Bearer ${this.settings.token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    })
    const json = (await res.json().catch(() => ({}))) as T & { message?: string }
    if (!res.ok) throw new Error(json.message ?? `${method} ${path} failed (${res.status})`)
    return json
  }

  get<T>(path: string) {
    return this.#req<T>('GET', path)
  }
  post<T>(path: string, body: unknown = {}) {
    return this.#req<T>('POST', path, body)
  }
  put<T>(path: string, body: unknown) {
    return this.#req<T>('PUT', path, body)
  }

  async health(timeoutMs = 1500): Promise<boolean> {
    try {
      const res = await fetch(`${this.settings.url}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      })
      return res.ok
    } catch {
      return false
    }
  }

  streamUrl(): string {
    return `${this.settings.url}/v1/stream?token=${encodeURIComponent(this.settings.token)}`
  }

  exportUrl(): string {
    const { url, token } = this.settings
    return token ? `${url}/v1/export.csv?token=${encodeURIComponent(token)}` : `${url}/v1/export.csv`
  }

  verifyBatch(id: number) {
    return this.post<BatchVerification>(`/v1/batches/${id}/verify`)
  }

  batchRows(id: number) {
    return this.get<{ rows: Record<string, unknown>[] }>(`/v1/batches/${id}`)
  }
}

/** Which parts of the dashboard each endpoint feeds; refreshed selectively on stream events. */
export const LOADERS: Record<string, (c: GatewayClient) => Promise<Partial<DashboardData>>> = {
  overview: async (c) => ({ overview: await c.get('/v1/overview') }),
  agents: async (c) => ({ agents: await c.get('/v1/agents') }),
  vendors: async (c) => ({ vendors: await c.get('/v1/vendors') }),
  channels: async (c) => ({ channels: await c.get('/v1/channels') }),
  float: async (c) => ({ float: await c.get('/v1/float') }),
  scores: async (c) => ({ scores: await c.get('/v1/scores') }),
  reconcile: async (c) => ({ reconcile: await c.get('/v1/reconcile') }),
  batches: async (c) => ({ batches: await c.get('/v1/batches') }),
  challenges: async (c) => ({ challenges: await c.get('/v1/challenges') }),
  policies: async (c) => ({ policies: await c.get('/v1/policies') }),
  vouchers: async (c) => ({ vouchers: await c.get('/v1/vouchers?limit=2000') }),
  timeline: async (c) => ({ timeline: (await c.get<AuditRow[]>('/v1/events?limit=500')).map(fromAudit) }),
}

/** The hosted site: the gateway's public reads at `/api`, no token (actions stay with the operator). */
export const HOSTED: GatewaySettings = { url: '/api', token: '' }

/** A live run on the hosted site, as `/api/demo/*` reports it. */
export interface DemoRun {
  readonly id: number
  readonly status: 'running' | 'done' | 'failed'
  readonly startedAt: number
  readonly elapsedMs: number
  readonly finishedAt: number | null
  readonly steps: readonly string[]
  readonly agents: readonly { id: string; vendorId: string; stopped: boolean; note: string | null }[]
  readonly error: string | null
}

export interface DemoStatus {
  readonly live: boolean
  readonly available: boolean
  readonly reason: string | null
  readonly cluster?: string
  readonly activeId?: number | null
  readonly latest: DemoRun | null
}

/** Generous: a cold serverless function opens the ledger first. */
export async function demoStatus(timeoutMs = 15_000): Promise<DemoStatus> {
  try {
    const res = await fetch('/api/demo/status', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
    if (res.ok) return (await res.json()) as DemoStatus
  } catch {
    // a static deployment (no API) or a timeout: no live ledger
  }
  return { live: false, available: false, reason: null, latest: null }
}

/** Starts a live run (or joins the one in progress). Throws the site's reason when it can't. */
export async function startDemoRun(): Promise<DemoRun> {
  const res = await fetch('/api/demo/run', { method: 'POST', cache: 'no-store' })
  const body = (await res.json().catch(() => ({}))) as { run?: DemoRun; message?: string }
  if (!res.ok || !body.run) throw new Error(body.message ?? `The live demo could not start (${res.status})`)
  return body.run
}

export async function tickDemoRun(id: number): Promise<DemoRun | null> {
  const res = await fetch('/api/demo/tick', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
    cache: 'no-store',
  })
  return res.ok ? ((await res.json()) as { run: DemoRun }).run : null
}

export interface FeedCursor {
  /** Newest voucher id seen. */
  readonly v: number
  /** Newest event id seen. */
  readonly e: number
}

export interface Feed {
  readonly patch: Partial<DashboardData>
  readonly run: DemoRun | null
  readonly cursor: FeedCursor
}

/**
 * One poll of the hosted ledger. `after` holds the newest voucher and event ids already shown: only rows
 * past them come back (less a small overlap, because concurrent inserts can commit out of id order).
 */
export async function fetchFeed(opts: { full: boolean; after: FeedCursor }): Promise<Feed> {
  const overlap = 50
  const q = new URLSearchParams()
  if (opts.full) q.set('full', '1')
  if (opts.after.v > overlap) q.set('v', String(opts.after.v - overlap))
  if (opts.after.e > overlap) q.set('e', String(opts.after.e - overlap))
  const res = await fetch(`/api/demo/feed?${q}`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`the live ledger did not answer (${res.status})`)
  const body = (await res.json()) as Partial<DashboardData> & {
    run: DemoRun | null
    events?: AuditRow[]
    full: boolean
    /** false when the site has no live ledger (the dashboard then shows the recorded run) */
    live?: boolean
    message?: string
  }
  if (body.live === false) throw new Error(body.message ?? 'the live ledger is offline')
  const { run, events, full: _full, live: _live, message: _message, ...views } = body
  const newest = (rows: { id: number }[] | undefined, prev: number) =>
    (rows ?? []).reduce((m, r) => Math.max(m, r.id), prev)
  return {
    run,
    patch: { ...views, ...(events ? { timeline: events.map(fromAudit) } : {}) },
    cursor: { v: newest(views.vouchers, opts.after.v), e: newest(events, opts.after.e) },
  }
}

/** Stream event type -> loaders worth refreshing afterwards. */
export const REFRESH_ON: Record<string, string[]> = {
  voucher: ['overview', 'agents', 'float', 'scores'],
  session_opened: ['channels', 'float', 'overview', 'agents'],
  session_closed: ['channels', 'float', 'overview', 'reconcile', 'agents'],
  challenge_blocked: ['challenges'],
  agent_killed: ['agents', 'overview'],
  agent_paused: ['agents', 'overview'],
  agent_revived: ['agents', 'overview'],
  global_kill: ['agents', 'overview'],
  global_unkill: ['agents', 'overview'],
  sweep: ['overview', 'float', 'agents'],
  top_up: ['overview', 'agents', 'float'],
  batch_anchored: ['batches', 'vouchers'],
  policy_changed: ['policies'],
  task_completed: ['scores'],
}
