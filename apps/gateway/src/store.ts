import { first, type LedgerDb, schema } from '@tabula/ledger'
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from '@tabula/ledger/sql'
import type { RegistryVendor } from './challenge.js'
import { sha256Hex } from './util.js'

/** Thin typed queries over the ledger. All amounts are integer micros. */
export class Store {
  constructor(readonly db: LedgerDb) {}

  // ---- agents ----------------------------------------------------------------------------
  async agentByApiKey(apiKey: string): Promise<schema.AgentRow | undefined> {
    return first(
      this.db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.apiKeyHash, sha256Hex(apiKey))),
    )
  }

  async agent(id: string): Promise<schema.AgentRow | undefined> {
    return first(this.db.select().from(schema.agents).where(eq(schema.agents.id, id)))
  }

  async agents(): Promise<schema.AgentRow[]> {
    return this.db.select().from(schema.agents)
  }

  async setAgentStatus(id: string, status: schema.AgentRow['status']): Promise<void> {
    await this.db.update(schema.agents).set({ status }).where(eq(schema.agents.id, id))
  }

  // ---- vendors ---------------------------------------------------------------------------
  async vendor(id: string): Promise<(RegistryVendor & schema.VendorRow) | undefined> {
    return first(this.db.select().from(schema.vendors).where(eq(schema.vendors.id, id)))
  }

  async vendors(): Promise<schema.VendorRow[]> {
    return this.db.select().from(schema.vendors)
  }

  // ---- tasks -----------------------------------------------------------------------------
  async ensureTask(t: {
    id: string
    agentId: string
    label: string
    taskType: string
    budget: number | null
  }) {
    await this.db
      .insert(schema.tasks)
      .values({ ...t, status: 'running', createdAt: Date.now() })
      .onConflictDoNothing()
  }

  async task(id: string): Promise<schema.TaskRow | undefined> {
    return first(this.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))
  }

  async completeTask(id: string, status: 'completed' | 'failed'): Promise<void> {
    await this.db.update(schema.tasks).set({ status, completedAt: Date.now() }).where(eq(schema.tasks.id, id))
  }

  // ---- channels --------------------------------------------------------------------------
  async insertChannel(row: typeof schema.channels.$inferInsert): Promise<void> {
    await this.db.insert(schema.channels).values(row)
  }

  async updateChannel(id: string, patch: Partial<typeof schema.channels.$inferInsert>): Promise<void> {
    await this.db.update(schema.channels).set(patch).where(eq(schema.channels.id, id))
  }

  async channel(id: string): Promise<schema.ChannelRow | undefined> {
    return first(this.db.select().from(schema.channels).where(eq(schema.channels.id, id)))
  }

  /**
   * Claims a channel's close: only one caller (on any instance) moves it from open to closing.
   * Returns the claimed row, or undefined when someone else already claimed it.
   */
  async claimClose(id: string, reason: string, now = Date.now()): Promise<schema.ChannelRow | undefined> {
    return first(
      this.db
        .update(schema.channels)
        .set({ status: 'closing', closeReason: reason, closingAt: now })
        .where(and(eq(schema.channels.id, id), eq(schema.channels.status, 'open')))
        .returning(),
    )
  }

  /** Re-claims a stalled close for this caller (bumps `closingAt`), so concurrent sweeps resume it once. */
  async claimResume(id: string, olderThanMs: number, now = Date.now()): Promise<boolean> {
    const rows = await this.db
      .update(schema.channels)
      .set({ closingAt: now })
      .where(
        and(
          eq(schema.channels.id, id),
          eq(schema.channels.status, 'closing'),
          or(isNull(schema.channels.closingAt), lt(schema.channels.closingAt, now - olderThanMs)),
        ),
      )
      .returning({ id: schema.channels.id })
    return rows.length > 0
  }

  /** Closes claimed more than `olderThanMs` ago that never finished (their instance stopped mid-close). */
  async stalledCloses(olderThanMs: number, now = Date.now()): Promise<schema.ChannelRow[]> {
    return this.db
      .select()
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.status, 'closing'),
          or(isNull(schema.channels.closingAt), lt(schema.channels.closingAt, now - olderThanMs)),
        ),
      )
  }

  async channels(statuses?: schema.ChannelRow['status'][]): Promise<schema.ChannelRow[]> {
    const q = this.db.select().from(schema.channels)
    return statuses ? q.where(inArray(schema.channels.status, statuses)) : q
  }

  // ---- vouchers --------------------------------------------------------------------------
  async insertVoucher(row: schema.NewVoucherRow): Promise<schema.VoucherRow> {
    const [r] = await this.db.insert(schema.vouchers).values(row).returning()
    return r!
  }

  async finalizeVoucher(
    id: number,
    patch: { responseStatus: schema.VoucherRow['responseStatus']; latencyMs: number | null },
  ) {
    const [r] = await this.db.update(schema.vouchers).set(patch).where(eq(schema.vouchers.id, id)).returning()
    return r!
  }

  async voucherByRequestId(channelId: string, requestId: string): Promise<schema.VoucherRow | undefined> {
    return first(
      this.db
        .select()
        .from(schema.vouchers)
        .where(and(eq(schema.vouchers.channelId, channelId), eq(schema.vouchers.requestId, requestId))),
    )
  }

  /** The highest signed voucher on a channel (the one a cooperative close replays). */
  async lastSignedVoucher(channelId: string): Promise<schema.VoucherRow | undefined> {
    return first(
      this.db
        .select()
        .from(schema.vouchers)
        .where(and(eq(schema.vouchers.channelId, channelId), eq(schema.vouchers.verdict, 'signed')))
        .orderBy(desc(schema.vouchers.cumulativeAmount))
        .limit(1),
    )
  }

  /**
   * Signed rows whose vendor call never finished (the gateway stopped mid-call): mark them timed out.
   * With several instances, only rows older than `olderThanMs` count (younger ones may still be in flight).
   */
  async finalizeDangling(olderThanMs = 0, now = Date.now()): Promise<number> {
    const rows = await this.db
      .update(schema.vouchers)
      .set({ responseStatus: 'timeout' })
      .where(
        and(
          eq(schema.vouchers.verdict, 'signed'),
          sql`${schema.vouchers.responseStatus} is null`,
          lt(schema.vouchers.ts, now - olderThanMs + 1),
        ),
      )
      .returning({ id: schema.vouchers.id })
    return rows.length
  }

  /** Rows ready to be committed to a batch: blocked, or signed with a recorded vendor outcome. */
  async unbatchedFinalized(limit: number): Promise<schema.VoucherRow[]> {
    return this.db
      .select()
      .from(schema.vouchers)
      .where(
        and(
          sql`${schema.vouchers.batchId} is null`,
          or(eq(schema.vouchers.verdict, 'blocked'), isNotNull(schema.vouchers.responseStatus)),
        ),
      )
      .orderBy(schema.vouchers.id)
      .limit(limit)
  }

  // ---- challenge checks ------------------------------------------------------------------
  async recordChallengeCheck(
    row: typeof schema.challengeChecks.$inferInsert,
  ): Promise<schema.ChallengeCheckRow> {
    const [r] = await this.db.insert(schema.challengeChecks).values(row).returning()
    return r!
  }
}
