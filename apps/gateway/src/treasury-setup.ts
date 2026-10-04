/**
 * One-time treasury setup (idempotent): a Squads vault holding the company's USDC, its
 * SubscriptionAuthority, and a recurring allowance per agent wallet. The resulting (non-secret)
 * addresses are written to a JSON state file the gateway loads at boot.
 */
import type { Address, KeyPairSigner } from '@solana/kit'
import {
  buildCreateRecurringAllowance,
  buildInitSubscriptionAuthority,
  type ClusterConfig,
  clusterUnixTime,
  createSquadsVault,
  executeAsVault,
  fetchAllowance,
  recurringDelegationFor,
  type SolanaRpc,
  type SquadsVault,
  setSolBalance,
  setTokenBalance,
  subscriptionAuthorityInitId,
  vaultFor,
} from '@tabula/solana'
import { loadTreasuryState, saveTreasuryState, type TreasuryState } from './treasury.js'

export type TreasurySetupLog = (message: string, txSignature?: string) => void

export async function ensureTreasury(args: {
  readonly rpc: SolanaRpc
  readonly cluster: ClusterConfig
  readonly mint: Address
  readonly admin: KeyPairSigner
  readonly createKey: KeyPairSigner
  readonly file: string
  /** Sandbox/localnet only: USDC to put in a freshly created vault via cheatcodes. */
  readonly fundVault?: bigint
  readonly log?: TreasurySetupLog
}): Promise<TreasuryState> {
  const log = args.log ?? (() => {})
  const { rpc, cluster, mint } = args
  let state = loadTreasuryState(args.file)
  let vault: SquadsVault | null = null
  if (state && state.cluster === cluster.name && state.rpcUrl === cluster.rpcUrl && state.mint === mint) {
    const { value } = await rpc.getAccountInfo(state.multisig as Address, { encoding: 'base64' }).send()
    if (value) {
      vault = vaultFor(state.multisig as Address, state.vaultIndex)
      log(`Reusing treasury vault ${vault.vault}`)
    }
  }
  if (!vault) {
    const created = await createSquadsVault(rpc, cluster.rpcUrl, args.admin, args.createKey)
    vault = created
    log(`Created Squads multisig ${created.multisig} (vault ${created.vault})`, created.signature)
    state = {
      cluster: cluster.name,
      rpcUrl: cluster.rpcUrl,
      mint,
      multisig: created.multisig,
      vault: created.vault,
      vaultIndex: created.vaultIndex,
      allowances: {},
    }
    if (cluster.cheatcodes) {
      // the vault pays rent for allowance accounts it creates inside vault transactions
      await setSolBalance(cluster.rpcUrl, created.vault, 2_000_000_000n)
      await setTokenBalance(cluster.rpcUrl, created.vault, mint, args.fundVault ?? 1_000_000_000n)
      log(`Funded the vault with ${(args.fundVault ?? 1_000_000_000n) / 1_000_000n} USDC (sandbox)`)
    }
    saveTreasuryState(args.file, state)
  }
  if ((await subscriptionAuthorityInitId(rpc, vault.vault, mint)) === null) {
    const r = await executeAsVault(rpc, cluster.rpcUrl, vault, args.admin, [
      await buildInitSubscriptionAuthority(vault.vault, mint),
    ])
    log('Vault initialized its SubscriptionAuthority (Subscriptions program)', r.executeSignature)
  }
  return state!
}

export interface AllowanceSpec {
  readonly agentId: string
  readonly payer: Address
  readonly amountPerPeriod: bigint
  readonly periodLengthS?: bigint
}

/** Creates any missing allowances in one vault transaction and waits until they are live. */
export async function ensureAllowances(args: {
  readonly rpc: SolanaRpc
  readonly cluster: ClusterConfig
  readonly mint: Address
  readonly admin: KeyPairSigner
  readonly file: string
  readonly state: TreasuryState
  readonly specs: readonly AllowanceSpec[]
  readonly log?: TreasurySetupLog
}): Promise<TreasuryState> {
  const log = args.log ?? (() => {})
  const { rpc, cluster, mint } = args
  const vault = vaultFor(args.state.multisig as Address, args.state.vaultIndex)
  const allowances = { ...args.state.allowances }
  const missing: (AllowanceSpec & { delegation: Address })[] = []
  for (const spec of args.specs) {
    const delegation = await recurringDelegationFor({ delegator: vault.vault, delegatee: spec.payer, mint })
    const existing = await fetchAllowance(rpc, delegation)
    if (existing.exists) {
      allowances[spec.agentId] = {
        delegation,
        payer: spec.payer,
        amountPerPeriod: existing.amountPerPeriod.toString(),
        periodLengthS: existing.periodLengthS.toString(),
      }
      continue
    }
    missing.push({ ...spec, delegation })
  }
  if (missing.length) {
    const initId = await subscriptionAuthorityInitId(rpc, vault.vault, mint)
    if (initId === null) throw new Error('vault SubscriptionAuthority missing; run ensureTreasury first')
    const now = await clusterUnixTime(rpc)
    const startTs = now + 20n // the deployed program rejects past or zero start times
    const ixs = await Promise.all(
      missing.map((m) =>
        buildCreateRecurringAllowance({
          delegator: vault.vault,
          delegatee: m.payer,
          mint,
          amountPerPeriod: m.amountPerPeriod,
          periodLengthS: m.periodLengthS ?? 86_400n,
          startTs,
          expiryTs: now + 365n * 86_400n,
          expectedInitId: initId,
        }),
      ),
    )
    const r = await executeAsVault(rpc, cluster.rpcUrl, vault, args.admin, ixs)
    log(
      `Vault granted ${missing.map((m) => `${m.agentId} $${Number(m.amountPerPeriod) / 1e6}/day`).join(', ')}`,
      r.executeSignature,
    )
    for (const m of missing) {
      allowances[m.agentId] = {
        delegation: m.delegation,
        payer: m.payer,
        amountPerPeriod: m.amountPerPeriod.toString(),
        periodLengthS: (m.periodLengthS ?? 86_400n).toString(),
      }
    }
    const giveUpAt = Date.now() + 120_000
    while ((await clusterUnixTime(rpc)) < startTs) {
      if (Date.now() > giveUpAt)
        throw new Error('allowances created, but the cluster clock has not reached their start time')
      await new Promise((res) => setTimeout(res, 1_000))
    }
  }
  const next = { ...args.state, allowances }
  saveTreasuryState(args.file, next)
  return next
}
