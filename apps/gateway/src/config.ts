import { join } from 'node:path'
import { type ClusterConfig, clusterFromEnv, keysDir } from '@tabula/solana'

export interface GatewayConfig {
  readonly port: number
  readonly host: string
  readonly dbPath: string
  readonly cluster: ClusterConfig
  /** Escrow mint (USDC on the sandbox). */
  readonly mint: string
  /** Bearer token for dashboard/admin actions (kill, policy edits, stream). */
  readonly adminToken: string
  /** Give up on a vendor call after this long and record it as a timeout. */
  readonly vendorTimeoutMs: number
  /** How long the kill path waits for a cooperative close before forcing one. */
  readonly cooperativeCloseTimeoutMs: number
  /** Top up agent wallets with cheatcodes when they run dry (sandbox/localnet demo only). */
  readonly demoFaucet: boolean
  /** Anchor a ledger batch every N finalized vouchers... */
  readonly anchorEvery: number
  /** ...or every this many ms, whichever comes first. 0 disables anchoring. */
  readonly anchorIntervalMs: number
  /** How often the float manager looks for idle channels and wallets. 0 disables the automatic sweeper. */
  readonly idleSweepMs: number
  /** A channel (or agent wallet) with no voucher for this long counts as idle. */
  readonly idleAfterMs: number
  /** Treasury state written by `pnpm setup` (Squads vault + allowances). Absent -> sandbox faucet. */
  readonly treasuryFile: string
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const cluster = clusterFromEnv(env)
  const mint = env.TABULA_MINT || cluster.defaultMint
  if (!mint) throw new Error('TABULA_MINT is required on devnet (run pnpm setup)')
  const num = (k: string, d: number) => (env[k] === undefined || env[k] === '' ? d : Number(env[k]))
  return {
    port: num('TABULA_GATEWAY_PORT', 4800),
    host: env.TABULA_GATEWAY_HOST || '127.0.0.1',
    dbPath: env.TABULA_DB_PATH || join(keysDir(), '..', 'data', 'tabula.sqlite'),
    cluster,
    mint,
    adminToken: env.TABULA_ADMIN_TOKEN || 'tabula-demo-admin',
    vendorTimeoutMs: num('TABULA_VENDOR_TIMEOUT_MS', 3_000),
    cooperativeCloseTimeoutMs: num('TABULA_COOP_CLOSE_TIMEOUT_MS', 20_000),
    demoFaucet: (env.TABULA_DEMO_FAUCET ?? (cluster.cheatcodes ? '1' : '0')) === '1',
    anchorEvery: num('TABULA_ANCHOR_EVERY', 50),
    anchorIntervalMs: num('TABULA_ANCHOR_INTERVAL_MS', 30_000),
    idleSweepMs: num('TABULA_IDLE_SWEEP_MS', 0),
    idleAfterMs: num('TABULA_IDLE_AFTER_MS', 5 * 60_000),
    treasuryFile: env.TABULA_TREASURY_FILE || join(keysDir(), '..', 'data', 'treasury.json'),
  }
}
