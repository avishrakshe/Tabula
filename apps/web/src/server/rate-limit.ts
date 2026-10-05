import { type LedgerDb, schema } from '@tabula/ledger'
import { sql } from '@tabula/ledger/sql'

/** Fixed-window counter: true while `key` has been hit at most `limit` times in the current window. */
export async function allow(db: LedgerDb, key: string, limit: number, windowMs: number, now = Date.now()) {
  const [row] = await db
    .insert(schema.rateLimits)
    .values({ key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: schema.rateLimits.key,
      set: {
        count: sql`case when ${schema.rateLimits.windowStart} < ${now - windowMs} then 1 else ${schema.rateLimits.count} + 1 end`,
        windowStart: sql`case when ${schema.rateLimits.windowStart} < ${now - windowMs} then ${now} else ${schema.rateLimits.windowStart} end`,
      },
    })
    .returning({ count: schema.rateLimits.count })
  return (row?.count ?? 0) <= limit
}
