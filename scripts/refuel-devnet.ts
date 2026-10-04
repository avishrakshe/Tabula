/**
 * `pnpm tsx --env-file=.env.devnet scripts/refuel-devnet.ts [--airdrop]`
 *
 * Tops the devnet deployment back up when the site says the live demo is refuelling: SOL for every
 * wallet (sent from the operator), and the treasury vault's test USDC back to $1,000. Then reports
 * what is left on each agent's daily allowance; that one refills itself, since the allowance period
 * resets onchain each day.
 *
 * Only the operator is funded by hand, at https://faucet.solana.com (devnet); --airdrop asks the RPC
 * faucet first (rate-limited, often refused). With DATABASE_URL set, the treasury is read from the
 * deployed ledger, the same one the site uses. Devnet SOL and test USDC only: no real funds.
 */
import { address } from '@solana/kit'
import { configFromEnv, createGateway } from '@tabula/gateway'
import { airdrop, createRpc, explorerTxUrl, loadOrCreateKeypair, solBalance } from '@tabula/solana'
import { DEMO_AGENTS } from './lib/demo-config.js'
import { OPERATOR_MIN, refillVault, SOL, topUpWallets } from './lib/devnet-funds.js'

const sol = (lamports: bigint) => `${(Number(lamports) / 1e9).toFixed(4)} SOL`
const usd = (micros: bigint) => `$${(Number(micros) / 1e6).toFixed(2)}`

async function main() {
  // serverless: read the treasury and nothing else (no session restore)
  const config = { ...configFromEnv(), serverless: true }
  const { cluster } = config
  if (cluster.cheatcodes) throw new Error('refuel is for devnet: the sandbox funds itself with cheatcodes')
  if (!process.env.TABULA_KEY_SEED)
    throw new Error('run with --env-file=.env.devnet (TABULA_KEY_SEED is not set)')
  const rpc = createRpc(cluster.rpcUrl)
  const tx = (signature?: string) => (signature ? `\n    ${explorerTxUrl(cluster, signature)}` : '')

  const operator = await loadOrCreateKeypair('tabula-operator')
  if (process.argv.includes('--airdrop')) {
    try {
      console.log(`Airdropped 1 SOL to the operator${tx(await airdrop(rpc, operator.address, SOL))}`)
    } catch (err) {
      console.log(`The faucet said no (${(err as Error).message.split('\n')[0]})`)
    }
  }
  const balance = await solBalance(rpc, operator.address)
  console.log(`Operator ${operator.address}: ${sol(balance)}`)
  if (balance < OPERATOR_MIN)
    console.log(
      `  Low: fund it with at least ${sol(OPERATOR_MIN - balance)} more at https://faucet.solana.com (devnet)`,
    )

  try {
    const r = await topUpWallets(rpc, operator)
    console.log(
      r.wallets
        ? `Topped up ${r.wallets} wallet(s) with ${sol(r.sol)}${tx(r.signature)}`
        : 'Every wallet has enough SOL',
    )
  } catch (err) {
    console.log(
      `Topping up the wallets failed (is the operator funded?): ${(err as Error).message.split('\n')[0]}`,
    )
  }

  const gw = await createGateway(config)
  try {
    const vault = gw.treasury.vaultAddress
    if (!vault) throw new Error('no treasury vault: run setup first')
    const r = await refillVault(rpc, operator, address(config.mint), address(vault))
    console.log(
      r.minted
        ? `Minted the vault ${usd(r.minted)} of test USDC${tx(r.mintSignature)}`
        : 'The vault holds $1,000',
    )
    if (r.solSignature) console.log(`Gave the vault 0.05 SOL for rent${tx(r.solSignature)}`)
    console.log('\nAllowances (refill daily, onchain):')
    for (const a of DEMO_AGENTS) {
      const al = await gw.treasury.allowance(a.id)
      console.log(`  ${a.id.padEnd(12)} ${al ? `${usd(al.remaining)} of ${usd(al.perPeriod)} left` : 'none'}`)
    }
  } finally {
    await gw.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
