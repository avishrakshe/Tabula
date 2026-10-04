/**
 * Opens the ledger: Postgres everywhere. Deployed, that is Supabase through its transaction-mode pooler
 * (postgres-js with prepared statements off). Locally and in tests it is PGlite, an embedded Postgres,
 * so nothing has to be installed; `:memory:` gives each test a fresh database.
 */
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import * as schema from './schema.js'

export type LedgerDb = PgDatabase<PgQueryResultHKT, typeof schema>
/** A transaction handle; every query method of `LedgerDb` works on it. */
export type LedgerTx = Parameters<Parameters<LedgerDb['transaction']>[0]>[0]

export interface Ledger {
  readonly db: LedgerDb
  readonly kind: 'postgres' | 'pglite'
  close(): Promise<void>
}

export interface OpenOptions {
  /** Apply pending migrations (always on for PGlite; for Postgres use a direct, non-pooled URL). */
  readonly migrate?: boolean
  /** Postgres connection pool size per process. */
  readonly max?: number
}

export const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url))

const isUrl = (target: string) => /^postgres(ql)?:\/\//.test(target)

/** `postgres://…` for a server, a directory for a file-backed PGlite, or `:memory:`. */
export async function openLedger(target: string, opts: OpenOptions = {}): Promise<Ledger> {
  if (isUrl(target)) {
    const { default: postgres } = await import('postgres')
    const { drizzle } = await import('drizzle-orm/postgres-js')
    // prepare: false because Supabase's transaction-mode pooler cannot hold prepared statements
    const client = postgres(target, { prepare: false, max: opts.max ?? 5, onnotice: () => {} })
    const db = drizzle(client, { schema })
    if (opts.migrate) {
      const { migrate } = await import('drizzle-orm/postgres-js/migrator')
      await migrate(db, { migrationsFolder: MIGRATIONS })
    }
    return { db: db as unknown as LedgerDb, kind: 'postgres', close: () => client.end({ timeout: 5 }) }
  }
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  if (target !== ':memory:') mkdirSync(target, { recursive: true })
  const client = target === ':memory:' ? new PGlite() : new PGlite(target)
  const db = drizzle(client, { schema })
  if (opts.migrate !== false) {
    const { migrate } = await import('drizzle-orm/pglite/migrator')
    await migrate(db, { migrationsFolder: MIGRATIONS })
  }
  return { db: db as unknown as LedgerDb, kind: 'pglite', close: () => client.close() }
}

/**
 * Runs `fn` in a transaction holding a transaction-scoped advisory lock on `key`, so concurrent requests
 * (on any number of function instances) for the same agent or channel run one at a time. Transaction-scoped
 * locks are safe behind a transaction-mode pooler; session locks are not.
 */
export function withLock<T>(db: LedgerDb, key: string, fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
    return fn(tx)
  })
}

/** First row of a query, or undefined (Postgres has no `.get()`). */
export async function first<T>(rows: Promise<T[]> | PromiseLike<T[]>): Promise<T | undefined> {
  return (await rows)[0]
}
