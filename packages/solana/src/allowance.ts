/**
 * Onchain ceilings with the Solana Subscriptions & Allowances program
 * (De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44, SDK @solana/subscriptions).
 *
 * The treasury (a Squads vault) gives each agent wallet a *recurring delegation*: it may pull at most
 * `amountPerPeriod` from the vault's token account per period (a daily budget, enforced onchain).
 * Tabula pulls just in time before opening or topping up a channel. Even if every off-chain check
 * failed, an agent wallet could never take more than its delegation from the treasury.
 */
import { type Address, createNoopSigner, type Instruction, type KeyPairSigner } from '@solana/kit'
import {
  fetchMaybeRecurringDelegation,
  fetchMaybeSubscriptionAuthority,
  findRecurringDelegationPda,
  findSubscriptionAuthorityPda,
  getCreateRecurringDelegationOverlayInstructionAsync,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getRevokeDelegationOverlayInstruction,
  getTransferRecurringOverlayInstructionAsync,
  UNKNOWN_INIT_ID,
} from '@solana/subscriptions'
import { TOKEN_PROGRAM } from './cluster'
import type { SolanaRpc } from './rpc'
import { ata } from './token'

export async function subscriptionAuthorityFor(owner: Address, mint: Address): Promise<Address> {
  const [pda] = await findSubscriptionAuthorityPda({ user: owner, tokenMint: mint })
  return pda
}

export async function recurringDelegationFor(args: {
  readonly delegator: Address
  readonly delegatee: Address
  readonly mint: Address
  readonly nonce?: bigint
}): Promise<Address> {
  const subscriptionAuthority = await subscriptionAuthorityFor(args.delegator, args.mint)
  const [pda] = await findRecurringDelegationPda({
    subscriptionAuthority,
    delegator: args.delegator,
    delegatee: args.delegatee,
    nonce: args.nonce ?? 0n,
  })
  return pda
}

/** Per-mint SubscriptionAuthority for `owner` (SPL-approves it on the owner's token account). Owner must sign. */
export async function buildInitSubscriptionAuthority(owner: Address, mint: Address): Promise<Instruction> {
  const signer = createNoopSigner(owner)
  return getInitSubscriptionAuthorityOverlayInstructionAsync({
    owner: signer,
    payer: signer,
    tokenMint: mint,
    tokenProgram: TOKEN_PROGRAM,
    userAta: await ata(owner, mint),
  })
}

/**
 * The live SubscriptionAuthority's `init_id` (its incarnation: the slot it was created in), or null
 * when it does not exist yet. New delegations must name it, so a re-initialized authority cannot
 * silently inherit old delegations.
 */
export async function subscriptionAuthorityInitId(
  rpc: SolanaRpc,
  owner: Address,
  mint: Address,
): Promise<bigint | null> {
  const acct = await fetchMaybeSubscriptionAuthority(
    rpc as never,
    await subscriptionAuthorityFor(owner, mint),
  )
  return acct.exists ? BigInt(acct.data.initId) : null
}

export interface RecurringAllowance {
  readonly delegator: Address
  readonly delegatee: Address
  readonly mint: Address
  readonly amountPerPeriod: bigint
  readonly periodLengthS: bigint
  /** Unix seconds; 0 = start when the transaction lands (requires an expiry). */
  readonly startTs: bigint
  readonly expiryTs: bigint
  readonly nonce?: bigint
  /**
   * The authority's `init_id`. Omit only when the authority is initialized in the same transaction
   * (the program's UNKNOWN_INIT_ID sentinel then requires a same-slot init).
   */
  readonly expectedInitId?: bigint
}

/** Delegator (the vault) grants `delegatee` a recurring allowance. Delegator must sign. */
export async function buildCreateRecurringAllowance(a: RecurringAllowance): Promise<Instruction> {
  const delegator = createNoopSigner(a.delegator)
  return getCreateRecurringDelegationOverlayInstructionAsync({
    delegator,
    payer: delegator,
    delegatee: a.delegatee,
    tokenMint: a.mint,
    amountPerPeriod: a.amountPerPeriod,
    periodLengthS: a.periodLengthS,
    startTs: a.startTs,
    expiryTs: a.expiryTs,
    nonce: a.nonce ?? 0n,
    expectedSubscriptionAuthorityInitId: a.expectedInitId ?? UNKNOWN_INIT_ID,
  })
}

export async function buildRevokeAllowance(delegator: Address, delegation: Address): Promise<Instruction> {
  return getRevokeDelegationOverlayInstruction({
    authority: createNoopSigner(delegator),
    delegationAccount: delegation,
  })
}

/** The agent wallet (delegatee) pulls `amount` from the treasury into its own token account. */
export async function buildPullFromAllowance(args: {
  readonly delegatee: KeyPairSigner
  readonly delegator: Address
  readonly mint: Address
  readonly amount: bigint
  readonly nonce?: bigint
}): Promise<Instruction> {
  return getTransferRecurringOverlayInstructionAsync({
    amount: args.amount,
    delegatee: args.delegatee,
    delegationPda: await recurringDelegationFor({
      delegator: args.delegator,
      delegatee: args.delegatee.address,
      mint: args.mint,
      nonce: args.nonce,
    }),
    delegator: args.delegator,
    delegatorAta: await ata(args.delegator, args.mint),
    receiverAta: await ata(args.delegatee.address, args.mint),
    tokenMint: args.mint,
    tokenProgram: TOKEN_PROGRAM,
  })
}

export interface AllowanceState {
  readonly address: Address
  readonly exists: boolean
  readonly amountPerPeriod: bigint
  readonly amountPulledInPeriod: bigint
  readonly currentPeriodStartTs: bigint
  readonly periodLengthS: bigint
  readonly expiryTs: bigint
  /** What the delegatee may still pull right now (a new period resets the counter). */
  readonly remaining: bigint
}

export async function fetchAllowance(
  rpc: SolanaRpc,
  delegation: Address,
  nowS: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Promise<AllowanceState> {
  const acct = await fetchMaybeRecurringDelegation(rpc as never, delegation)
  if (!acct.exists) {
    return {
      address: delegation,
      exists: false,
      amountPerPeriod: 0n,
      amountPulledInPeriod: 0n,
      currentPeriodStartTs: 0n,
      periodLengthS: 0n,
      expiryTs: 0n,
      remaining: 0n,
    }
  }
  const d = acct.data
  const expired = d.expiryTs !== 0n && nowS >= d.expiryTs
  const rolled = d.periodLengthS > 0n && nowS >= d.currentPeriodStartTs + d.periodLengthS
  const pulled = rolled ? 0n : d.amountPulledInPeriod
  return {
    address: delegation,
    exists: true,
    amountPerPeriod: d.amountPerPeriod,
    amountPulledInPeriod: d.amountPulledInPeriod,
    currentPeriodStartTs: d.currentPeriodStartTs,
    periodLengthS: d.periodLengthS,
    expiryTs: d.expiryTs,
    remaining: expired ? 0n : d.amountPerPeriod - pulled,
  }
}
