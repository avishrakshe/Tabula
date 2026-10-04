/**
 * `pnpm setup` — prepares the demo environment on the Solana Payment Sandbox (default):
 *
 *   1. demo keypairs in the gitignored keys/ folder (Tabula admin + operator, agent wallets and
 *      voucher keys, vendor payees) — generated at runtime, never committed
 *   2. a Squads v4 vault holding the company's USDC (sandbox balances, no real funds)
 *   3. a recurring daily allowance (Subscriptions program) from the vault to each agent wallet:
 *      the onchain ceiling
 *   4. the gateway ledger: vendor registry, agents (fresh API keys) and policies
 *
 * Writes data/treasury.json (addresses, not secret) and keys/agents.json (agent API keys, secret).
 * Idempotent: re-running reuses the vault and allowances and rotates the agent API keys.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { address } from '@solana/kit'
import {
  type AgentSpec,
  configFromEnv,
  createGateway,
  ensureAllowances,
  ensureTreasury,
  newApiKey,
  registerAgent,
  registerVendor,
} from '@tabula/gateway'
import {
  createRpc,
  explorerAddressUrl,
  explorerTxUrl,
  keysDir,
  loadOrCreateKeypair,
  setSolBalance,
} from '@tabula/solana'
import { DEMO_VENDORS, pricePerCall } from '@tabula/vendor-mock'

const config = configFromEnv()
const { cluster } = config
if (!cluster.cheatcodes) {
  throw new Error(
    'pnpm setup currently targets the Payment Sandbox or a local surfpool. On devnet the vendor side ' +
      '(@solana/mpp 0.11 settlement) uses the mainnet treasury constant, so distribute would fail; see docs/FACTS.md.',
  )
}
const mint = address(config.mint)
const rpc = createRpc(cluster.rpcUrl)
const log = (msg: string, tx?: string) => console.log(tx ? `${msg}\n    ${explorerTxUrl(cluster, tx)}` : msg)

export const DEMO_AGENTS: AgentSpec[] = [
  {
    id: 'research-01',
    name: 'Research agent',
    role: 'Summarises papers for the research team',
    department: 'Research',
    dailyBudget: 5_000_000,
    policy: {
      dailyBudgetUsd: 5,
      perTaskBudgetUsd: 2,
      velocity: { windowSec: 60, maxUsd: 0.2 },
      anomaly: { zScore: 6, minSamples: 30, bucketSec: 10 },
    },
  },
  {
    id: 'coder-01',
    name: 'Coding agent',
    role: 'Writes and reviews code',
    department: 'Engineering',
    dailyBudget: 5_000_000,
    policy: { dailyBudgetUsd: 5, perTaskBudgetUsd: 2, velocity: { windowSec: 60, maxUsd: 0.2 } },
  },
  {
    id: 'rogue-01',
    name: 'Ops agent',
    role: 'Triage bot reading inbound tickets (the one that gets prompt-injected)',
    department: 'Operations',
    dailyBudget: 5_000_000,
    policy: { dailyBudgetUsd: 5, perTaskBudgetUsd: 2, velocity: { windowSec: 60, maxUsd: 0.2 } },
  },
]

async function main() {
  console.log(`Tabula setup on ${cluster.name} (${cluster.rpcUrl})\n`)
  const admin = await loadOrCreateKeypair('tabula-admin')
  const operator = await loadOrCreateKeypair('tabula-operator')
  await setSolBalance(cluster.rpcUrl, admin.address, 20_000_000_000n)
  await setSolBalance(cluster.rpcUrl, operator.address, 20_000_000_000n)
  log(`Tabula admin    ${admin.address} (Squads member)\nTabula operator ${operator.address} (pays fees)`)

  let state = await ensureTreasury({
    rpc,
    cluster,
    mint,
    admin,
    createKey: await loadOrCreateKeypair('treasury-createkey'),
    file: config.treasuryFile,
    fundVault: 1_000_000_000n,
    log,
  })
  const specs = []
  for (const a of DEMO_AGENTS) {
    const payer = await loadOrCreateKeypair(`agent-${a.id}-payer`)
    specs.push({ agentId: a.id, payer: payer.address, amountPerPeriod: BigInt(a.dailyBudget) })
  }
  state = await ensureAllowances({ rpc, cluster, mint, admin, file: config.treasuryFile, state, specs, log })

  const gw = await createGateway(config)
  try {
    if (gw.treasury.kind !== 'squads-allowance')
      throw new Error(`expected the Squads treasury, got ${gw.treasury.kind}`)
    await gw.policy.setPolicy(
      'global',
      null,
      {
        vendors: { allow: ['inference-a', 'inference-b'] },
        maxUnitPriceUsd: 0.00001,
        onViolation: 'kill_and_close',
      },
      'setup',
    )
    for (const v of DEMO_VENDORS.filter((x) => x.id !== 'mirror')) {
      const payee = await loadOrCreateKeypair(v.payeeKey)
      await registerVendor(gw, {
        id: v.id,
        name: v.name,
        endpoint: `http://127.0.0.1:${v.port}/v1/infer`,
        payeePubkey: payee.address,
        mint,
        programId: cluster.paymentChannelsProgram,
        unitName: v.unitName,
        unitPrice: Number(v.unitPrice),
        maxUnitPrice: Number(v.unitPrice) * 2,
        taskType: v.taskType,
      })
      log(`Vendor ${v.id.padEnd(12)} payee ${payee.address}  ${pricePerCall(v)} micros/call`)
    }
    const apiKeys: Record<string, string> = {}
    for (const a of DEMO_AGENTS) apiKeys[a.id] = (await registerAgent(gw, a, newApiKey()))!
    const keysFile = join(keysDir(), 'agents.json')
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
    console.log(`Ledger: ${config.dbPath}\nTreasury state: ${config.treasuryFile}\n\nNext: pnpm demo`)
  } finally {
    await gw.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
