/**
 * Milestone 3 spike — the onchain ceiling: a Squads v4 vault funds per-agent allowances from the
 * Subscriptions & Allowances program. Proves on the sandbox:
 *
 *   1. create a threshold-1 Squads multisig (Tabula admin is the member) and fund its vault
 *   2. vault transaction: init the vault's SubscriptionAuthority + a recurring daily allowance to an agent wallet
 *   3. the agent wallet pulls within the cap
 *   4. pulling past the cap is rejected by the program
 *
 * Run: pnpm tsx scripts/spike-ceiling.ts
 */
import {
  buildCreateRecurringAllowance,
  buildInitSubscriptionAuthority,
  buildPullFromAllowance,
  clusterFromEnv,
  clusterUnixTime,
  createAtaIdempotentIx,
  createRpc,
  createSquadsVault,
  ephemeralKeypair,
  executeAsVault,
  explorerTxUrl,
  fetchAllowance,
  ownerTokenBalance,
  recurringDelegationFor,
  sendAndConfirm,
  setSolBalance,
  setTokenBalance,
  simulate,
  subscriptionAuthorityInitId,
} from '@tabula/solana'

const cluster = clusterFromEnv()
if (!cluster.cheatcodes || !cluster.defaultMint) throw new Error('needs sandbox/localnet')
const mint = cluster.defaultMint
const rpc = createRpc(cluster.rpcUrl)
const log = console.log
const DAILY = 2_000_000n // $2.00 per day

async function main() {
  const admin = await ephemeralKeypair()
  const createKey = await ephemeralKeypair()
  const agent = await ephemeralKeypair()
  await setSolBalance(cluster.rpcUrl, admin.address, 10_000_000_000n)
  await setSolBalance(cluster.rpcUrl, agent.address, 100_000_000n)

  const vault = await createSquadsVault(rpc, cluster.rpcUrl, admin, createKey)
  log(
    `1. multisig ${vault.multisig}\n   vault    ${vault.vault}\n   ${explorerTxUrl(cluster, vault.signature)}`,
  )
  await setSolBalance(cluster.rpcUrl, vault.vault, 1_000_000_000n) // pays allowance-account rent inside vault txs
  await setTokenBalance(cluster.rpcUrl, vault.vault, mint, 100_000_000n)
  log(`   vault funded: ${(await ownerTokenBalance(rpc, vault.vault, mint)) / 1_000_000n} USDC`)

  // vault tx 1: the vault's SubscriptionAuthority. The deployed program predates the same-slot
  // UNKNOWN_INIT_ID sentinel, so the delegation (vault tx 2) names the authority's real init_id.
  const init = await executeAsVault(rpc, cluster.rpcUrl, vault, admin, [
    await buildInitSubscriptionAuthority(vault.vault, mint),
  ])
  const initId = await subscriptionAuthorityInitId(rpc, vault.vault, mint)
  log(`   vault tx #${init.transactionIndex}: subscription authority init_id=${initId}`)
  if (initId === null) throw new Error('authority missing after init')
  // it also rejects start_ts = 0 and past starts: start just ahead of the cluster clock
  const now = await clusterUnixTime(rpc)
  const startTs = now + 20n
  const exec = await executeAsVault(rpc, cluster.rpcUrl, vault, admin, [
    await buildCreateRecurringAllowance({
      delegator: vault.vault,
      delegatee: agent.address,
      mint,
      amountPerPeriod: DAILY,
      periodLengthS: 86_400n,
      startTs,
      expiryTs: now + 30n * 86_400n,
      expectedInitId: initId,
    }),
  ])
  while ((await clusterUnixTime(rpc)) < startTs) await new Promise((r) => setTimeout(r, 1000))
  const delegation = await recurringDelegationFor({ delegator: vault.vault, delegatee: agent.address, mint })
  const state = await fetchAllowance(rpc, delegation)
  log(`2. vault tx #${exec.transactionIndex} executed: ${explorerTxUrl(cluster, exec.executeSignature)}`)
  log(
    `   allowance ${delegation}: ${state.amountPerPeriod} per ${state.periodLengthS}s, remaining ${state.remaining}`,
  )
  if (state.amountPerPeriod !== DAILY) throw new Error('allowance not created as expected')

  const pull = await sendAndConfirm(rpc, {
    feePayer: agent,
    instructions: [
      await createAtaIdempotentIx(agent, agent.address, mint),
      await buildPullFromAllowance({ delegatee: agent, delegator: vault.vault, mint, amount: 1_500_000n }),
    ],
  })
  const after = await fetchAllowance(rpc, delegation)
  log(`3. agent pulled $1.50: ${explorerTxUrl(cluster, pull)}`)
  log(
    `   agent balance ${await ownerTokenBalance(rpc, agent.address, mint)}, remaining allowance ${after.remaining}`,
  )
  if (after.remaining !== 500_000n) throw new Error(`expected 500000 remaining, got ${after.remaining}`)

  const over = await simulate(rpc, agent, [
    await buildPullFromAllowance({ delegatee: agent, delegator: vault.vault, mint, amount: 600_000n }),
  ])
  log(`4. pulling $0.60 more (cap leaves $0.50): ${over.err ? 'REJECTED onchain' : 'ACCEPTED?!'}`)
  log(`   ${JSON.stringify(over.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
  log(
    `   ${over.logs
      .filter((l) => /Error|error|exceed/i.test(l))
      .slice(0, 3)
      .join('\n   ')}`,
  )
  if (!over.err) throw new Error('over-cap pull should fail')
  log('\nCEILING SPIKE PASSED')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
