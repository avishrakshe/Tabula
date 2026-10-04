import { type Address, address } from '@solana/kit'

/**
 * Clusters Tabula runs against. Real funds are out of scope, so mainnet is deliberately absent.
 *
 * - `sandbox`: the hosted Solana Payment Sandbox (surfnet, clones mainnet state lazily, exposes
 *   `surfnet_*` cheatcodes for funding). The payment-channels program here is the mainnet build.
 * - `devnet`: public devnet. The payment-channels program is a devnet build with its own treasury.
 * - `localnet`: a local surfpool (`surfpool start`), same semantics as the sandbox.
 *
 * See docs/FACTS.md for how each value below was confirmed.
 */
export type ClusterName = 'sandbox' | 'devnet' | 'localnet'

export interface ClusterConfig {
  readonly name: ClusterName
  readonly rpcUrl: string
  readonly paymentChannelsProgram: Address
  /** `TREASURY_OWNER` baked into this cluster's program build; `distribute` validates ATA(owner, mint). */
  readonly treasuryOwner: Address
  /** Whether the RPC exposes surfnet cheatcodes (`surfnet_setAccount`, `surfnet_setTokenAccount`). */
  readonly cheatcodes: boolean
  /** Default escrow mint. `null` means setup must create a test mint (devnet). */
  readonly defaultMint: Address | null
}

export const PAYMENT_CHANNELS_PROGRAM = address('CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX')
export const SUBSCRIPTIONS_PROGRAM = address('De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44')
export const SQUADS_V4_PROGRAM = address('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf')
export const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const ASSOCIATED_TOKEN_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
export const RENT_SYSVAR = address('SysvarRent111111111111111111111111111111111')
export const INSTRUCTIONS_SYSVAR = address('Sysvar1nstructions1111111111111111111111111')

/** Mainnet USDC. On the sandbox, balances of this mint are set with cheatcodes (no real funds). */
export const USDC_MAINNET_MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')

const MAINNET_BUILD_TREASURY = address('Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP')
const DEVNET_BUILD_TREASURY = address('4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap')

export const SANDBOX_RPC_URL = 'https://402.surfnet.dev:8899'

export function resolveCluster(name: ClusterName = 'sandbox', rpcOverride?: string): ClusterConfig {
  switch (name) {
    case 'sandbox':
      return {
        name,
        rpcUrl: rpcOverride || SANDBOX_RPC_URL,
        paymentChannelsProgram: PAYMENT_CHANNELS_PROGRAM,
        treasuryOwner: MAINNET_BUILD_TREASURY,
        cheatcodes: true,
        defaultMint: USDC_MAINNET_MINT,
      }
    case 'localnet':
      return {
        name,
        rpcUrl: rpcOverride || 'http://127.0.0.1:8899',
        paymentChannelsProgram: PAYMENT_CHANNELS_PROGRAM,
        treasuryOwner: MAINNET_BUILD_TREASURY,
        cheatcodes: true,
        defaultMint: USDC_MAINNET_MINT,
      }
    case 'devnet':
      return {
        name,
        rpcUrl: rpcOverride || 'https://api.devnet.solana.com',
        paymentChannelsProgram: PAYMENT_CHANNELS_PROGRAM,
        treasuryOwner: DEVNET_BUILD_TREASURY,
        cheatcodes: false,
        defaultMint: null,
      }
  }
}

export function clusterFromEnv(env: NodeJS.ProcessEnv = process.env): ClusterConfig {
  const name = (env.TABULA_CLUSTER ?? 'sandbox') as ClusterName
  if (!['sandbox', 'devnet', 'localnet'].includes(name)) {
    throw new Error(`TABULA_CLUSTER must be sandbox, devnet or localnet (got "${name}")`)
  }
  return resolveCluster(name, env.TABULA_RPC_URL)
}

/**
 * An RPC URL safe to show or record: scheme and host only. Paid providers put the API key in the query
 * (`?api-key=`) or the path (`/v2/<key>`).
 */
export function publicRpcUrl(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'unknown'
  }
}

function explorerSuffix(cluster: Pick<ClusterConfig, 'name' | 'rpcUrl'>): string {
  if (cluster.name === 'devnet') return '?cluster=devnet'
  return `?cluster=custom&customUrl=${encodeURIComponent(cluster.rpcUrl)}`
}

export function explorerTxUrl(cluster: Pick<ClusterConfig, 'name' | 'rpcUrl'>, signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${explorerSuffix(cluster)}`
}

export function explorerAddressUrl(cluster: Pick<ClusterConfig, 'name' | 'rpcUrl'>, addr: string): string {
  return `https://explorer.solana.com/address/${addr}${explorerSuffix(cluster)}`
}
