/**
 * Opens the ledger: Node's built-in `node:sqlite` behind drizzle's sqlite-proxy driver, so there is
 * no native module to build. WAL mode keeps the gateway's writes durable across restarts.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator'
import * as schema from './schema.js'

export type LedgerDb = SqliteRemoteDatabase<typeof schema>

export interface Ledger {
  readonly db: LedgerDb
  readonly sqlite: DatabaseSync
  close(): void
}

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url))

export async function openLedger(path: string): Promise<Ledger> {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const sqlite = new DatabaseSync(path)
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
  const cache = new Map<string, StatementSync>()
  const prepare = (sql: string): StatementSync => {
    let st = cache.get(sql)
    if (!st) {
      st = sqlite.prepare(sql)
      st.setReturnArrays(true)
      cache.set(sql, st)
    }
    return st
  }
  const db = drizzle(
    async (sql, params, method) => {
      const st = prepare(sql)
      const args = params as SQLInputValue[]
      if (method === 'run') {
        st.run(...args)
        return { rows: [] }
      }
      if (method === 'get') return { rows: st.get(...args) as unknown as unknown[] }
      return { rows: st.all(...args) as unknown as unknown[][] }
    },
    { schema },
  )
  await migrate(
    db,
    async (queries) => {
      sqlite.exec('BEGIN')
      try {
        for (const q of queries) sqlite.exec(q)
        sqlite.exec('COMMIT')
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
    },
    { migrationsFolder: MIGRATIONS },
  )
  return { db, sqlite, close: () => sqlite.close() }
}
