/**
 * `pnpm tsx --env-file=.env.local scripts/migrate.ts` — applies pending ledger migrations to Postgres.
 *
 * `pnpm setup` does this too, but a deployed site gains tables between setups (the landing page's
 * waitlist, for one), and this needs no Solana access. Migrations don't belong on the transaction
 * pooler, so it prefers DIRECT_URL, then POSTGRES_URL_NON_POOLING (what the Supabase Marketplace
 * integration sets; `vercel env pull` writes it to .env.local), then DATABASE_URL / POSTGRES_URL.
 * PGlite ledgers migrate themselves when opened, so there is nothing to do without a Postgres URL.
 */
import { openLedger } from '@tabula/ledger'

async function main() {
  const env = process.env
  const url = env.DIRECT_URL || env.POSTGRES_URL_NON_POOLING || env.DATABASE_URL || env.POSTGRES_URL
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    console.log('No Postgres URL set: nothing to migrate (local PGlite ledgers migrate on open).')
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
