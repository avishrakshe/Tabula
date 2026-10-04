import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Address, KeyPairSigner } from '@solana/kit'
import { first, type LedgerDb, schema } from '@tabula/ledger'
import { eq } from '@tabula/ledger/sql'
import { formatUsd } from '@tabula/policy'
import {
  buildPullFromAllowance,
  type ClusterConfig,
  clusterUnixTime,
  createAtaIdempotentIx,
  fetchAllowance,
  ownerTokenBalance,
  publicRpcUrl,
  recurringDelegationFor,
  type SolanaRpc,
  type SquadsVault,
  sendAndConfirm,
  setTokenBalance,
  transferCheckedIx,
} from '@tabula/solana'
import type { Custody } from './custody'

export interface FundingResult {
  /** Amount moved into the agent wallet (0 when it already had enough). */
  readonly moved: bigint
  readonly source: string
  readonly txSignature?: string
}

export interface SweepResult {
  readonly amount: bigint
  readonly txSignature?: string
  readonly destination?: string
}

/** The onchain ceiling refused a pull: the agent's allowance cannot cover the deposit. */
export class CeilingError extends Error {
  constructor(
    message: string,
    readonly remaining: bigint,
  ) {
    super(message)
    this.name = 'CeilingError'
  }
}

/**
 * Where agent wallets get escrow money from and where idle money goes back to.
 * - `FaucetTreasury`: sandbox only, cheatcode top-ups, no onchain ceiling (tests and quick demos).
 * - `CeilingTreasury`: a Squads vault that grants each agent wallet a recurring allowance through the
 *   Subscriptions program; the gateway pulls just in time and sweeps idle float back to the vault.
 */
export interface Treasury {
  readonly kind: string
  readonly vaultAddress: string | null
  ensureFunded(agentId: string, payer: KeyPairSigner, amount: bigint): Promise<FundingResult>
  /** What the agent can still put into escrow: wallet balance + what the allowance still lets it pull. Null = unlimited. */
  remainingCeiling(agentId: string): Promise<bigint | null>
  /** Allowance details for dashboards (null when there is no onchain ceiling). */
  allowance(
    agentId: string,
  ): Promise<{ address: string; perPeriod: bigint; remaining: bigint; periodS: bigint } | null>
  /** Moves an agent wallet's balance back to the treasury. */
  sweep(agentId: string, payer: KeyPairSigner): Promise<SweepResult>
  vaultBalance(): Promise<bigint | null>
}

/** Sandbox/localnet only: tops agent wallets up with surfnet cheatcodes. No onchain ceiling. */
export class FaucetTreasury implements Treasury {
  readonly kind = 'sandbox-faucet'
  readonly vaultAddress = null
  constructor(
    private readonly cluster: ClusterConfig,
    private readonly rpc: SolanaRpc,
    private readonly mint: Address,
    private readonly topUpTo: bigint = 5_000_000n,
  ) {
    if (!cluster.cheatcodes) throw new Error('FaucetTreasury needs a cheatcode cluster (sandbox or localnet)')
  }

  async ensureFunded(_agentId: string, payer: KeyPairSigner, amount: bigint): Promise<FundingResult> {
    const balance = await ownerTokenBalance(this.rpc, payer.address, this.mint)
    if (balance >= amount) return { moved: 0n, source: this.kind }
    const target = amount > this.topUpTo ? amount : this.topUpTo
    await setTokenBalance(this.cluster.rpcUrl, payer.address, this.mint, target)
    return { moved: target - balance, source: this.kind }
  }

  async remainingCeiling(): Promise<bigint | null> {
    return null
  }

  async allowance() {
    return null
  }

  async sweep(): Promise<SweepResult> {
    return { amount: 0n }
  }

  async vaultBalance(): Promise<bigint | null> {
    return null
  }
}

/** Persisted (non-secret) treasury setup: which vault, which allowance per agent. */
export interface TreasuryState {
  readonly cluster: string
  readonly rpcUrl: string
  readonly mint: string
  readonly multisig: string
  readonly vault: string
  readonly vaultIndex: number
  readonly allowances: Record<
    string,
    {
      readonly delegation: string
      readonly payer: string
      readonly amountPerPeriod: string
      readonly periodLengthS: string
    }
  >
}

/**
 * Whether a saved setup belongs to this cluster and mint. Devnet is one network whichever RPC provider
 * serves it; a cheatcode cluster (sandbox, localnet) is only the same one at the same host.
 */
export function treasuryMatches(state: TreasuryState, cluster: ClusterConfig, mint: string): boolean {
  if (state.cluster !== cluster.name || state.mint !== mint) return false
  return !cluster.cheatcodes || publicRpcUrl(state.rpcUrl) === publicRpcUrl(cluster.rpcUrl)
}

export function loadTreasuryState(file: string): TreasuryState | null {
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8')) as TreasuryState
}

export function saveTreasuryState(file: string, state: TreasuryState): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
}

/** The treasury setup as stored in the ledger's settings table (serverless instances have no state file). */
export async function loadTreasurySetting(db: LedgerDb): Promise<TreasuryState | null> {
  const row = await first(db.select().from(schema.settings).where(eq(schema.settings.key, 'treasury')))
  return row ? (JSON.parse(row.valueJson) as TreasuryState) : null
}

export async function saveTreasurySetting(db: LedgerDb, state: TreasuryState): Promise<void> {
  const valueJson = JSON.stringify(state)
  await db
    .insert(schema.settings)
    .values({ key: 'treasury', valueJson, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { valueJson, updatedAt: Date.now() } })
}

export class CeilingTreasury implements Treasury {
  readonly kind = 'squads-allowance'

  constructor(
    private readonly rpc: SolanaRpc,
    private readonly mint: Address,
    readonly vault: SquadsVault,
    private readonly custody: Custody,
  ) {}

  get vaultAddress(): string {
    return this.vault.vault
  }

  async #state(payer: Address) {
    const delegation = await recurringDelegationFor({
      delegator: this.vault.vault,
      delegatee: payer,
      mint: this.mint,
    })
    return fetchAllowance(this.rpc, delegation, await clusterUnixTime(this.rpc))
  }

  async ensureFunded(agentId: string, payer: KeyPairSigner, amount: bigint): Promise<FundingResult> {
    const balance = await ownerTokenBalance(this.rpc, payer.address, this.mint)
    if (balance >= amount) return { moved: 0n, source: 'agent wallet float' }
    const need = amount - balance
    const allowance = await this.#state(payer.address)
    if (!allowance.exists)
      throw new CeilingError(`${agentId} has no onchain allowance from the treasury vault`, 0n)
    if (allowance.remaining < need) {
      throw new CeilingError(
        `${agentId}'s onchain allowance has ${formatUsd(allowance.remaining)} left this period; ${formatUsd(need)} more is needed`,
        allowance.remaining,
      )
    }
    const operator = this.custody.operator
    const txSignature = await sendAndConfirm(this.rpc, {
      feePayer: operator,
      instructions: [
        await createAtaIdempotentIx(operator, payer.address, this.mint),
        await buildPullFromAllowance({
          delegatee: payer,
          delegator: this.vault.vault,
          mint: this.mint,
          amount: need,
        }),
      ],
    })
    return { moved: need, source: 'the treasury vault (onchain allowance)', txSignature }
  }

  async remainingCeiling(agentId: string): Promise<bigint | null> {
    const { payer } = await this.custody.agentKeys(agentId)
    const [balance, allowance] = await Promise.all([
      ownerTokenBalance(this.rpc, payer.address, this.mint),
      this.#state(payer.address),
    ])
    return balance + (allowance.exists ? allowance.remaining : 0n)
  }

  async allowance(agentId: string) {
    const { payer } = await this.custody.agentKeys(agentId)
    const s = await this.#state(payer.address)
    if (!s.exists) return null
    return {
      address: s.address,
      perPeriod: s.amountPerPeriod,
      remaining: s.remaining,
      periodS: s.periodLengthS,
    }
  }

  async sweep(_agentId: string, payer: KeyPairSigner): Promise<SweepResult> {
    const balance = await ownerTokenBalance(this.rpc, payer.address, this.mint)
    if (balance === 0n) return { amount: 0n }
    const operator = this.custody.operator
    const txSignature = await sendAndConfirm(this.rpc, {
      feePayer: operator,
      instructions: [
        await transferCheckedIx({
          authority: payer,
          mint: this.mint,
          destinationOwner: this.vault.vault,
          amount: balance,
          decimals: 6,
        }),
      ],
    })
    return { amount: balance, txSignature, destination: this.vault.vault }
  }

  async vaultBalance(): Promise<bigint | null> {
    return ownerTokenBalance(this.rpc, this.vault.vault, this.mint)
  }
}
