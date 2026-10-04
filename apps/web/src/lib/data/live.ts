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
        authorization: `Bearer ${this.settings.token}`,
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
    return `${this.settings.url}/v1/export.csv?token=${encodeURIComponent(this.settings.token)}`
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
