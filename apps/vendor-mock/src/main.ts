/**
 * Starts demo vendors. Usage:
 *   pnpm --filter @tabula/vendor-mock start              # all demo vendors
 *   pnpm --filter @tabula/vendor-mock start inference-a  # one vendor
 */
import { clusterFromEnv } from '@tabula/solana'
import { DEMO_VENDORS, demoVendor } from './config.js'
import { startVendor } from './start.js'

const cluster = clusterFromEnv()
const mint = process.env.TABULA_MINT ?? cluster.defaultMint
if (!mint) throw new Error('set TABULA_MINT (devnet has no default mint; run pnpm setup first)')
const ids = process.argv.slice(2)
const configs = ids.length ? ids.map(demoVendor) : DEMO_VENDORS

for (const cfg of configs) {
  const v = await startVendor(cfg, cluster, mint)
  console.log(
    `${cfg.id.padEnd(12)} ${v.url}  payee ${v.payee}  ${cfg.unitsPerCall} ${cfg.unitName}s @ ${cfg.unitPrice} micros`,
  )
}
console.log(`cluster ${cluster.name} (${cluster.rpcUrl}); Ctrl+C to stop`)
