/**
 * An MPP `SessionStore` on Postgres, so a vendor can run as serverless functions: every instance sees the
 * same channel state. `updateChannel` is the SDK's only write and must be atomic per channel; it runs the
 * mutator inside a transaction holding an advisory lock on (vendor, channel), so concurrent vouchers on one
 * channel apply one at a time on any number of instances. Records round-trip as JSON (bigints tagged, and
 * unknown fields kept verbatim, as the SDK requires of durable stores).
 */
import {
  CHANNEL_STATE_SCHEMA_VERSION,
  type ChannelMutator,
  type ChannelState,
  type ListChannelsFilter,
  type SessionStore,
} from '@solana/mpp/server'
import { first, type LedgerDb, schema, withLock } from '@tabula/ledger'
import { and, eq } from '@tabula/ledger/sql'

const encode = (state: ChannelState): string =>
  JSON.stringify(state, (_k, v) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v))

const decode = (json: string): ChannelState => {
  const state = JSON.parse(json, (_k, v) =>
    v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).length === 1 &&
    typeof v.$bigint === 'string'
      ? BigInt(v.$bigint)
      : v,
  ) as ChannelState
  if ((state.schemaVersion ?? 0) > CHANNEL_STATE_SCHEMA_VERSION)
    throw new Error(`channel ${state.channelId} was written by a newer SDK (schema v${state.schemaVersion})`)
  return state
}

export function createPostgresSessionStore(db: LedgerDb, vendorId: string): SessionStore {
  const row = (tx: LedgerDb, channelId: string) =>
    first(
      tx
        .select()
        .from(schema.vendorSessions)
        .where(
          and(eq(schema.vendorSessions.vendorId, vendorId), eq(schema.vendorSessions.channelId, channelId)),
        ),
    )

  const updateChannel = (channelId: string, mutator: ChannelMutator): Promise<ChannelState> =>
    withLock(db, `vendor:${vendorId}:channel:${channelId}`, async (tx) => {
      const current = await row(tx, channelId)
      const next = await mutator(current ? decode(current.stateJson) : undefined)
      await tx
        .insert(schema.vendorSessions)
        .values({ vendorId, channelId, stateJson: encode(next), updatedAt: Date.now() })
        .onConflictDoUpdate({
          target: [schema.vendorSessions.vendorId, schema.vendorSessions.channelId],
          set: { stateJson: encode(next), updatedAt: Date.now() },
        })
      return next
    })

  return {
    async getChannel(channelId) {
      const r = await row(db, channelId)
      return r ? decode(r.stateJson) : undefined
    },
    async listChannels(filter?: ListChannelsFilter) {
      const rows = await db
        .select()
        .from(schema.vendorSessions)
        .where(eq(schema.vendorSessions.vendorId, vendorId))
      return rows
        .map((r) => decode(r.stateJson))
        .filter((s) => filter?.sealed === undefined || s.sealed === filter.sealed)
        .filter((s) => !filter?.closePending || s.closeRequestedAt !== undefined)
    },
    updateChannel,
    async markSealed(channelId) {
      return updateChannel(channelId, (current) => {
        if (!current) throw new Error(`channel ${channelId} not found`)
        return { ...current, sealed: true }
      })
    },
    async deleteChannel(channelId) {
      await db
        .delete(schema.vendorSessions)
        .where(
          and(eq(schema.vendorSessions.vendorId, vendorId), eq(schema.vendorSessions.channelId, channelId)),
        )
    },
  }
}
