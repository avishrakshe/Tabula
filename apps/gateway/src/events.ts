import { EventEmitter } from 'node:events'
import { type LedgerDb, schema } from '@tabula/ledger'

/**
 * Everything the dashboard shows live. `voucher` events mirror ledger rows (the vouchers table is
 * the record); every other kind is also appended to the `events` audit log.
 */
export type GatewayEventType =
  | 'voucher'
  | 'session_opened'
  | 'session_closed'
  | 'challenge_blocked'
  | 'challenge_ok'
  | 'agent_killed'
  | 'agent_paused'
  | 'agent_revived'
  | 'global_kill'
  | 'global_unkill'
  | 'kill_step'
  | 'refund'
  | 'sweep'
  | 'top_up'
  | 'float_sized'
  | 'batch_anchored'
  | 'policy_changed'
  | 'reconciled'
  | 'task_completed'
  | 'faucet'

export interface GatewayEvent {
  readonly id?: number
  readonly type: GatewayEventType
  readonly ts: number
  readonly message: string
  readonly agentId?: string | null
  readonly channelId?: string | null
  readonly txSignature?: string | null
  readonly explorerUrl?: string | null
  readonly data?: Record<string, unknown>
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

export class EventBus {
  readonly #emitter = new EventEmitter()

  constructor(private readonly db: LedgerDb) {
    this.#emitter.setMaxListeners(100)
  }

  /** Broadcasts and (except for vouchers) appends to the audit log. Returns the stored event. */
  async emit(e: Omit<GatewayEvent, 'ts'> & { ts?: number }): Promise<GatewayEvent> {
    const event: GatewayEvent = {
      ...e,
      ts: e.ts ?? Date.now(),
      data: jsonSafe(e.data ?? {}) as Record<string, unknown>,
    }
    let stored = event
    if (event.type !== 'voucher') {
      const [row] = await this.db
        .insert(schema.events)
        .values({
          ts: event.ts,
          type: event.type,
          agentId: event.agentId ?? null,
          channelId: event.channelId ?? null,
          message: event.message,
          dataJson: JSON.stringify({ ...event.data, explorerUrl: event.explorerUrl ?? undefined }),
          txSignature: event.txSignature ?? null,
        })
        .returning({ id: schema.events.id })
      stored = { ...event, id: row?.id }
    }
    this.#emitter.emit('event', stored)
    return stored
  }

  subscribe(fn: (e: GatewayEvent) => void): () => void {
    this.#emitter.on('event', fn)
    return () => this.#emitter.off('event', fn)
  }
}
