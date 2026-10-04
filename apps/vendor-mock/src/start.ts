import { createHmac } from 'node:crypto'
import { serve } from '@hono/node-server'
import type { LedgerDb } from '@tabula/ledger'
import {
  type ClusterConfig,
  createRpc,
  loadOrCreateKeypair,
  ownerTokenBalance,
  setSolBalance,
  setTokenBalance,
} from '@tabula/solana'
import type { VendorConfig } from './config.js'
import { createPostgresSessionStore } from './pg-store.js'
import { createVendorApp, type VendorDeps } from './server.js'

/**
 * A vendor for serverless hosting (a route handler in the web app): payee and fee-payer keys derived
 * from TABULA_KEY_SEED, session state in Postgres, and a challenge secret every instance shares (so a
 * 402 challenge issued by one instance verifies on another). Funding is the deployment's job, not this.
 */
export async function createHostedVendor(
  config: VendorConfig,
  cluster: ClusterConfig,
  mint: string,
  opts: { db: LedgerDb; basePath: string },
) {
  const seed = process.env.TABULA_KEY_SEED
  if (!seed)
    throw new Error('hosted vendors need TABULA_KEY_SEED (their keys and challenge secret derive from it)')
  const secretKey = createHmac('sha256', Buffer.from(seed, 'hex'))
    .update(`tabula/v1/vendor-${config.id}-mpp-secret`)
    .digest('base64')
  return createVendorApp(config, {
    cluster,
    mint,
    payee: await loadOrCreateKeypair(config.payeeKey),
    operator: await loadOrCreateKeypair(`vendor-${config.id}-operator`),
    secretKey,
    store: createPostgresSessionStore(opts.db, config.id),
    basePath: opts.basePath,
  })
}

export interface RunningVendor {
  readonly config: VendorConfig
  readonly url: string
  readonly payee: string
  readonly operator: string
  readonly setDown: (down: boolean) => void
  close(): Promise<void>
}

/**
 * Loads (or creates) the vendor's payee and operator keys under keys/, makes sure they can pay fees
 * and hold the mint on cheatcode clusters, and starts the HTTP server.
 */
export async function startVendor(
  config: VendorConfig,
  cluster: ClusterConfig,
  mint: string,
  opts: Partial<Pick<VendorDeps, 'timeoutHoldMs' | 'noLatency'>> & { port?: number; host?: string } = {},
): Promise<RunningVendor> {
  const payee = await loadOrCreateKeypair(config.payeeKey)
  const operator = await loadOrCreateKeypair(`vendor-${config.id}-operator`)
  if (cluster.cheatcodes) {
    const rpc = createRpc(cluster.rpcUrl)
    const [opSol, payeeSol] = await Promise.all([
      rpc.getBalance(operator.address).send(),
      rpc.getBalance(payee.address).send(),
    ])
    if (opSol.value < 2_000_000_000n) await setSolBalance(cluster.rpcUrl, operator.address, 20_000_000_000n)
    if (payeeSol.value < 500_000_000n) await setSolBalance(cluster.rpcUrl, payee.address, 2_000_000_000n)
    // distribute needs the payee's token account to exist, or the payout is redirected to treasury
    const balance = await ownerTokenBalance(rpc, payee.address, mint as never)
    await setTokenBalance(cluster.rpcUrl, payee.address, mint as never, balance)
  }
  const vendor = createVendorApp(config, { cluster, mint, payee, operator, ...opts })
  const port = opts.port ?? config.port
  const host = opts.host ?? '127.0.0.1'
  const server = serve({ fetch: vendor.app.fetch, port, hostname: host })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  return {
    config,
    url: `http://${host}:${boundPort}`,
    payee: payee.address,
    operator: operator.address,
    setDown: vendor.setDown,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
