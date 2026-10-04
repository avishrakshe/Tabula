/**
 * `pnpm tsx --env-file=.env.devnet scripts/devnet-wallets.ts [--airdrop]`
 *
 * Lists the devnet wallets the deployment uses (derived from TABULA_KEY_SEED) with their SOL balances.
 * With --airdrop, asks the devnet faucet for 1 SOL for the operator (it is rate-limited and often says
 * no; then fund the operator at https://faucet.solana.com and re-run setup).
 */
import { airdrop, createRpc, loadOrCreateKeypair, resolveCluster, solBalance } from '@tabula/solana'

const WALLETS = [
  ['tabula-operator', 'pays Tabula-side fees; funds the others during setup'],
  ['tabula-admin', 'Squads treasury member'],
  ['vendor-inference-a-operator', 'Inference A fee payer'],
  ['vendor-inference-b-operator', 'Inference B fee payer'],
  ['vendor-mirror-operator', 'the malicious mirror fee payer'],
] as const

async function main() {
  if (!process.env.TABULA_KEY_SEED)
    throw new Error('run with --env-file=.env.devnet (TABULA_KEY_SEED is not set)')
  const cluster = resolveCluster('devnet', process.env.TABULA_RPC_URL)
  const rpc = createRpc(cluster.rpcUrl)
  for (const [name, role] of WALLETS) {
    const k = await loadOrCreateKeypair(name)
    const sol = Number(await solBalance(rpc, k.address)) / 1e9
    console.log(`${name.padEnd(28)} ${k.address}  ${sol.toFixed(4).padStart(9)} SOL  ${role}`)
  }
  if (process.argv.includes('--airdrop')) {
    const op = await loadOrCreateKeypair('tabula-operator')
    try {
      const sig = await airdrop(rpc, op.address, 1_000_000_000n)
      console.log(`\nairdropped 1 SOL to the operator: https://explorer.solana.com/tx/${sig}?cluster=devnet`)
    } catch (err) {
      console.log(`\nthe faucet said no (${(err as Error).message.split('\n')[0]}).`)
      console.log(`Fund ${op.address} at https://faucet.solana.com (devnet), then re-run.`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
