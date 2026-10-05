/**
 * `pnpm tsx --env-file=.env scripts/migrate.ts` — applies pending ledger migrations to Postgres.
 *
 * `pnpm setup` does this too, but a deployed site gains tables between setups (the landing page's
 * waitlist, for one), and this needs no Solana access. Uses DIRECT_URL (Supabase's direct connection;
 * migrations don't belong on the transaction pooler), else DATABASE_URL. PGlite ledgers migrate
 * themselves when opened, so there is nothing to do without a Postgres URL.
 */
import { openLedger } from '@tabula/ledger'

async function main() {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    console.log('No DIRECT_URL or DATABASE_URL: nothing to migrate (local PGlite ledgers migrate on open).')
    return
  }
  const ledger = await openLedger(url, { migrate: true, max: 1 })
  await ledger.close()
  console.log(`Applied the ledger migrations to ${new URL(url).host}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
