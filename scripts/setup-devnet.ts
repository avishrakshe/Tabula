/**
 * `pnpm setup` — prepares the demo environment.
 *
 * Solana Payment Sandbox (default; `pnpm setup`):
 *   1. demo keypairs in the gitignored keys/ folder, funded with cheatcodes (no real funds)
 *   2. a Squads v4 vault holding $1,000 of (sandbox) USDC
 *   3. a recurring daily allowance (Subscriptions program) from the vault to each agent wallet:
 *      the onchain ceiling
 *   4. the gateway ledger: vendor registry, agents (fresh API keys) and policies
 *
 * Devnet (`pnpm tsx --env-file=.env.devnet scripts/setup-devnet.ts`): the same, except
 *   - every key derives from TABULA_KEY_SEED (the deployment holds one secret, not a keys folder);
 *   - SOL comes from the operator wallet, which you fund at faucet.solana.com, and setup tops up the
 *     admin and the vendors' fee payers from it;
 *   - the escrow token is a test-USDC mint Tabula creates (its address derives from the seed; the
 *     operator is its mint authority), and setup mints the vault $1,000 of it.
 *
 * Options (env): DATABASE_URL targets Supabase (migrations run against DIRECT_URL first);
 * TABULA_VENDOR_BASE=https://<site>/api/vendors registers the hosted vendors instead of local ports.
 * Idempotent: re-running reuses the mint, vault and allowances, and rotates the agent API keys.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Address, address } from '@solana/kit'
import {
  configFromEnv,
  createGateway,
  ensureAllowances,
  ensureTreasury,
  newApiKey,
  registerAgent,
  saveTreasurySetting,
} from '@tabula/gateway'
import { openLedger } from '@tabula/ledger'
import {
  type ClusterConfig,
  clusterFromEnv,
  createAtaIdempotentIx,
  createRpc,
  ensureTestMint,
  explorerAddressUrl,
  explorerTxUrl,
  keysDir,
  loadOrCreateKeypair,
  type SolanaRpc,
  sendAndConfirm,
  setSolBalance,
  solBalance,
} from '@tabula/solana'
import { DEMO_VENDORS } from '@tabula/vendor-mock'
import { DEMO_AGENTS, GLOBAL_POLICY, registerDemoVendors } from './lib/demo-config.js'
import { OPERATOR_MIN, refillVault, SOL, topUpWallets, VAULT_USDC } from './lib/devnet-funds.js'

const log = (cluster: ClusterConfig, msg: string, tx?: string) =>
  console.log(tx ? `${msg}\n    ${explorerTxUrl(cluster, tx)}` : msg)

/** Devnet: wallets funded from the operator, and the test-USDC mint. Returns the mint. */
async function prepareDevnet(cluster: ClusterConfig, rpc: SolanaRpc): Promise<Address> {
  if (!process.env.TABULA_KEY_SEED)
    throw new Error('devnet setup needs TABULA_KEY_SEED (use --env-file=.env.devnet)')
  const operator = await loadOrCreateKeypair('tabula-operator')
  const balance = await solBalance(rpc, operator.address)
  if (balance < OPERATOR_MIN) {
    throw new Error(
      `the operator ${operator.address} has ${Number(balance) / 1e9} SOL; fund it with at least ` +
        `${Number(OPERATOR_MIN) / 1e9} SOL at https://faucet.solana.com (devnet) and re-run`,
    )
  }
  log(cluster, `Tabula operator ${operator.address}: ${Number(balance) / 1e9} SOL`)
  const topUp = await topUpWallets(rpc, operator)
  if (topUp.wallets)
    log(
      cluster,
      `Topped up ${topUp.wallets} wallet(s) from the operator (admin, vendor fee payers)`,
      topUp.signature,
    )
  const mintKey = await loadOrCreateKeypair('devnet-test-usdc-mint')
  const created = await ensureTestMint(rpc, operator, mintKey, operator.address)
  log(
    cluster,
    created.created
      ? `Created the test-USDC mint ${mintKey.address} (6 decimals; the operator is mint authority)`
      : `Reusing the test-USDC mint ${mintKey.address}`,
    created.signature,
  )
  return mintKey.address
}

/** Records TABULA_MINT in .env.devnet so later runs (and you) do not have to. */
function rememberMint(mint: string): void {
  const file = '.env.devnet'
  if (!existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  if (/^TABULA_MINT=/m.test(text)) return
  writeFileSync(file, `${text.replace(/\n?$/, '\n')}TABULA_MINT=${mint}\n`)
  console.log(`Saved TABULA_MINT=${mint} to ${file}`)
}

async function main() {
  const cluster = clusterFromEnv()
  const rpc = createRpc(cluster.rpcUrl)
  console.log(`Tabula setup on ${cluster.name} (${cluster.rpcUrl})\n`)
  if (!cluster.cheatcodes) {
    const mint = await prepareDevnet(cluster, rpc)
    if (process.env.TABULA_MINT && process.env.TABULA_MINT !== mint)
      throw new Error(`TABULA_MINT (${process.env.TABULA_MINT}) is not this seed's test mint (${mint})`)
    process.env.TABULA_MINT = mint
    rememberMint(mint)
  }
  const config = configFromEnv()
  const mint = address(config.mint)

  const admin = await loadOrCreateKeypair('tabula-admin')
  const operator = await loadOrCreateKeypair('tabula-operator')
  if (cluster.cheatcodes) {
    await setSolBalance(cluster.rpcUrl, admin.address, 20n * SOL)
    await setSolBalance(cluster.rpcUrl, operator.address, 20n * SOL)
  }
  log(
    cluster,
    `Tabula admin    ${admin.address} (Squads member)\nTabula operator ${operator.address} (pays fees)`,
  )

  let state = await ensureTreasury({
    rpc,
    cluster,
    mint,
    admin,
    createKey: await loadOrCreateKeypair('treasury-createkey'),
    file: config.treasuryFile,
    fundVault: VAULT_USDC,
    // no cheatcodes: mint the vault its test USDC (creating its token account, which the
    // SubscriptionAuthority needs), and give it SOL for the accounts it pays rent on
    prepareVault: async (vault) => {
      const r = await refillVault(rpc, operator, mint, vault)
      if (r.minted) log(cluster, `Minted the vault ${Number(r.minted) / 1e6} test USDC`, r.mintSignature)
      if (r.solSignature)
        log(cluster, 'Gave the vault 0.05 SOL for the accounts it pays rent on', r.solSignature)
    },
    log: (m, tx) => log(cluster, m, tx),
  })
  const specs = []
  for (const a of DEMO_AGENTS) {
    const payer = await loadOrCreateKeypair(`agent-${a.id}-payer`)
    specs.push({ agentId: a.id, payer: payer.address, amountPerPeriod: BigInt(a.dailyBudget) })
  }
  state = await ensureAllowances({
    rpc,
    cluster,
    mint,
    admin,
    file: config.treasuryFile,
    state,
    specs,
    log: (m, tx) => log(cluster, m, tx),
  })

  if (!cluster.cheatcodes) {
    // distribute pays into the payee's token account and sweeps dust to the program treasury's: both must exist
    const owners = [
      ...new Set([
        ...(await Promise.all(
          DEMO_VENDORS.map(async (v) => (await loadOrCreateKeypair(v.payeeKey)).address),
        )),
        cluster.treasuryOwner,
      ]),
    ]
    const tx = await sendAndConfirm(rpc, {
      feePayer: operator,
      instructions: await Promise.all(owners.map((o) => createAtaIdempotentIx(operator, o, mint))),
    })
    log(cluster, `Token accounts for the vendor payees and the program treasury exist`, tx)
  }

  if (/^postgres(ql)?:\/\//.test(config.dbPath)) {
    const direct = process.env.DIRECT_URL || config.dbPath
    const ledger = await openLedger(direct, { migrate: true, max: 1 })
    await ledger.close()
    console.log('Applied the ledger migrations to Postgres')
  }
  const gw = await createGateway(config)
  try {
    if (gw.treasury.kind !== 'squads-allowance')
      throw new Error(`expected the Squads treasury, got ${gw.treasury.kind}`)
    await saveTreasurySetting(gw.ledger.db, state)
    await gw.policy.setPolicy('global', null, GLOBAL_POLICY, 'setup')
    for (const v of await registerDemoVendors(gw, process.env.TABULA_VENDOR_BASE))
      log(cluster, `Vendor ${v.id.padEnd(12)} payee ${v.payee}  ${v.endpoint}`)
    const apiKeys: Record<string, string> = {}
    for (const a of DEMO_AGENTS) apiKeys[a.id] = (await registerAgent(gw, a, newApiKey()))!
    const keysFile = join(keysDir(), `agents${cluster.cheatcodes ? '' : `.${cluster.name}`}.json`)
    writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2), { mode: 0o600 })

    console.log(`\nTreasury vault ${state.vault}\n    ${explorerAddressUrl(cluster, state.vault)}`)
    console.log(`Vault balance  $${Number((await gw.treasury.vaultBalance()) ?? 0n) / 1e6}`)
    for (const a of DEMO_AGENTS) {
      const al = await gw.treasury.allowance(a.id)
      console.log(
        `  ${a.id.padEnd(12)} allowance $${Number(al?.perPeriod ?? 0n) / 1e6}/day, $${Number(al?.remaining ?? 0n) / 1e6} left  ${al?.address}`,
      )
    }
    console.log(`\nAgent API keys written to ${keysFile} (gitignored).`)
    console.log(`Ledger: ${/^postgres/.test(config.dbPath) ? 'Postgres (DATABASE_URL)' : config.dbPath}`)
    console.log(`Treasury state: ${config.treasuryFile} and the ledger's settings\n\nNext: pnpm demo`)
  } finally {
    await gw.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
