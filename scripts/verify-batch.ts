/**
 * Recomputes ledger batch Merkle roots from the database and checks them against the memos anchored
 * onchain. Exits non-zero if any batch fails.
 *
 *   pnpm tsx scripts/verify-batch.ts            # every anchored batch
 *   pnpm tsx scripts/verify-batch.ts 3          # batch 3 only
 *   TABULA_DB_PATH=data/demo-pg pnpm tsx scripts/verify-batch.ts      # the last pnpm demo run
 *   DATABASE_URL=postgres://… pnpm tsx scripts/verify-batch.ts         # the deployed ledger
 */
import { Anchorer, configFromEnv, EventBus } from '@tabula/gateway'
import { openLedger, schema } from '@tabula/ledger'
import { createRpc, ephemeralKeypair } from '@tabula/solana'

const config = configFromEnv()
const arg = process.argv[2]

async function main() {
  const ledger = await openLedger(config.dbPath)
  try {
    const rpc = createRpc(config.cluster.rpcUrl)
    // verification only reads; the anchoring key is never needed here
    const anchorer = new Anchorer(
      ledger.db,
      rpc,
      config.cluster,
      await ephemeralKeypair(),
      new EventBus(ledger.db),
    )
    const batches = await ledger.db.select().from(schema.batches).orderBy(schema.batches.id)
    const targets = arg
      ? batches.filter((b) => b.id === Number(arg))
      : batches.filter((b) => b.status === 'anchored')
    if (targets.length === 0) {
      console.log(arg ? `no batch ${arg} in ${config.dbPath}` : `no anchored batches in ${config.dbPath}`)
      process.exit(arg ? 1 : 0)
    }
    let failed = 0
    for (const b of targets) {
      const v = await anchorer.verify(b.id)
      const mark = v.match ? 'MATCH   ' : 'MISMATCH'
      console.log(
        `${mark} batch ${v.batchId}: ${v.voucherCount} rows  root ${v.recomputedRoot.slice(0, 16)}…  ${v.reason}`,
      )
      if (v.explorerUrl) console.log(`         ${v.explorerUrl}`)
      if (!v.match) failed++
    }
    console.log(`\n${targets.length - failed}/${targets.length} batches verified against their onchain memos`)
    process.exitCode = failed ? 1 : 0
  } finally {
    await ledger.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
