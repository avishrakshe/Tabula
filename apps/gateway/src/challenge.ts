/**
 * Payment-request verification, run before Tabula signs anything for a new channel:
 *
 *   parse 402 challenge -> registry lookup -> compare payee, mint, program, price, splits, signer mode
 *   -> build the open transaction -> simulate -> compare pre/post balances -> (only then) sign.
 *
 * A prompt-injected agent can be talked into calling a different endpoint, but it cannot change
 * where the money goes: the payee must be the one registered for the vendor the agent named.
 */

import { type Address, type Base64EncodedWireTransaction, getBase64Encoder } from '@solana/kit'
import type { SessionChallenge } from '@solana/mpp/client'
import { ata, type ClusterConfig, type SolanaRpc } from '@tabula/solana'

export type ChallengeVerdict =
  | 'OK'
  | 'UNKNOWN_VENDOR'
  | 'NOT_A_SESSION_CHALLENGE'
  | 'PAYEE_MISMATCH'
  | 'MINT_MISMATCH'
  | 'PROGRAM_MISMATCH'
  | 'NETWORK_MISMATCH'
  | 'PRICE_MISMATCH'
  | 'SPLITS_MISMATCH'
  | 'SIGNER_MODE_MISMATCH'
  | 'FEE_PAYER_MISMATCH'
  | 'SIMULATION_MISMATCH'

export interface RegistryVendor {
  readonly id: string
  readonly name: string
  readonly payeePubkey: string
  readonly mint: string
  readonly programId: string
  readonly unitPrice: number
  readonly maxUnitPrice: number
  readonly unitName: string
  readonly allowlisted: boolean
}

export interface ChallengeCheck {
  readonly verdict: ChallengeVerdict
  readonly reason: string
  readonly payeeOffered?: string
  readonly mintOffered?: string
  readonly programOffered?: string
  readonly priceOffered?: bigint
  /** Units per call implied by the challenged price at the registered unit price. */
  readonly unitsPerCall?: number
}

export function expectedNetwork(cluster: ClusterConfig): string {
  return cluster.name === 'devnet' ? 'devnet' : 'localnet'
}

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a)

/** Pure field comparison of a session challenge against the vendor registry. */
export function verifyChallengeFields(
  challenge: SessionChallenge,
  vendor: RegistryVendor | undefined,
  cluster: ClusterConfig,
  vendorId: string,
): ChallengeCheck {
  const req = challenge.request
  const details = req.methodDetails
  const offered = {
    payeeOffered: req.recipient,
    mintOffered: req.currency,
    programOffered: details?.channelProgram,
    priceOffered: /^\d+$/.test(req.amount ?? '') ? BigInt(req.amount) : undefined,
  }
  if (!vendor) {
    return { verdict: 'UNKNOWN_VENDOR', reason: `"${vendorId}" is not in the vendor registry`, ...offered }
  }
  if (challenge.intent !== 'session' || challenge.method !== 'solana' || !details) {
    return {
      verdict: 'NOT_A_SESSION_CHALLENGE',
      reason: 'the vendor did not offer a Solana payment-channel session',
      ...offered,
    }
  }
  if (req.recipient !== vendor.payeePubkey) {
    return {
      verdict: 'PAYEE_MISMATCH',
      reason: `the payment request names payee ${short(req.recipient)}, but ${vendor.name} is registered to ${short(vendor.payeePubkey)}`,
      ...offered,
    }
  }
  if (req.currency !== vendor.mint) {
    return {
      verdict: 'MINT_MISMATCH',
      reason: `asks to be paid in ${short(req.currency)} instead of ${short(vendor.mint)}`,
      ...offered,
    }
  }
  if (
    details.channelProgram !== cluster.paymentChannelsProgram ||
    vendor.programId !== cluster.paymentChannelsProgram
  ) {
    return {
      verdict: 'PROGRAM_MISMATCH',
      reason: `escrow would go to program ${short(details.channelProgram)}, not the payment-channels program`,
      ...offered,
    }
  }
  if (details.network !== expectedNetwork(cluster)) {
    return {
      verdict: 'NETWORK_MISMATCH',
      reason: `challenge is for network "${details.network}"`,
      ...offered,
    }
  }
  const price = offered.priceOffered
  const unit = BigInt(vendor.unitPrice)
  if (price === undefined || price <= 0n || unit <= 0n || price % unit !== 0n) {
    return {
      verdict: 'PRICE_MISMATCH',
      reason: `asks ${req.amount} per call, which is not a whole number of ${vendor.unitName}s at the registered price`,
      ...offered,
    }
  }
  if (details.distributionSplits && details.distributionSplits.length > 0) {
    return {
      verdict: 'SPLITS_MISMATCH',
      reason: `the channel would split payments to ${details.distributionSplits.length} extra recipient(s)`,
      ...offered,
    }
  }
  if ((details.voucherSigner ?? 'client') !== 'client') {
    return {
      verdict: 'SIGNER_MODE_MISMATCH',
      reason: 'the vendor wants to sign vouchers itself, which would take spending out of Tabula’s control',
      ...offered,
    }
  }
  if (!details.feePayer || !details.feePayerKey) {
    return {
      verdict: 'FEE_PAYER_MISMATCH',
      reason: 'the vendor does not sponsor channel fees and rent',
      ...offered,
    }
  }
  return {
    verdict: 'OK',
    reason: 'payment request matches the registry',
    ...offered,
    unitsPerCall: Number(price / unit),
  }
}

export interface SimulationCheck {
  readonly ok: boolean
  readonly reason: string
  readonly payerLamportsDelta: bigint
  readonly payerTokenDelta: bigint
  readonly escrowTokenAfter: bigint
  readonly logs: readonly string[]
}

function tokenAmount(data: readonly [string, string] | undefined | null): bigint {
  if (!data) return 0n
  const bytes = getBase64Encoder().encode(data[0])
  if (bytes.length < 72) return 0n
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(64, true)
}

/**
 * Simulates the (partially signed) open transaction and checks its only effects on the agent are
 * the escrow deposit: the agent wallet's SOL is untouched (the vendor sponsors fee and rent), its
 * token balance drops by exactly `deposit`, and the channel escrow holds exactly `deposit`.
 */
export async function simulateOpen(
  rpc: SolanaRpc,
  args: {
    readonly transaction: string
    readonly payer: Address
    readonly channel: Address
    readonly mint: Address
    readonly deposit: bigint
  },
): Promise<SimulationCheck> {
  const payerAta = await ata(args.payer, args.mint)
  const escrowAta = await ata(args.channel, args.mint)
  const addresses = [args.payer, payerAta, escrowAta]
  const pre = await rpc.getMultipleAccounts(addresses, { encoding: 'base64', commitment: 'confirmed' }).send()
  const sim = await rpc
    .simulateTransaction(args.transaction as Base64EncodedWireTransaction, {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses },
    })
    .send()
  const v = sim.value as unknown as {
    err: unknown
    logs: string[] | null
    accounts: ({ lamports: bigint; data: [string, string] } | null)[] | null
  }
  const preAcc = pre.value as unknown as ({ lamports: bigint; data: [string, string] } | null)[]
  const post = v.accounts ?? []
  const payerLamportsDelta = (post[0]?.lamports ?? 0n) - (preAcc[0]?.lamports ?? 0n)
  const payerTokenDelta = tokenAmount(post[1]?.data) - tokenAmount(preAcc[1]?.data)
  const escrowTokenAfter = tokenAmount(post[2]?.data)
  const base = { payerLamportsDelta, payerTokenDelta, escrowTokenAfter, logs: v.logs ?? [] }
  if (v.err)
    return {
      ok: false,
      reason: `the open transaction fails in simulation: ${JSON.stringify(v.err, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))}`,
      ...base,
    }
  if (payerLamportsDelta !== 0n) {
    return {
      ok: false,
      reason: `opening would spend ${-payerLamportsDelta} lamports of the agent wallet's SOL`,
      ...base,
    }
  }
  if (payerTokenDelta !== -args.deposit) {
    return {
      ok: false,
      reason: `the agent wallet would lose ${-payerTokenDelta} instead of the ${args.deposit} deposit`,
      ...base,
    }
  }
  if (escrowTokenAfter !== args.deposit) {
    return {
      ok: false,
      reason: `the escrow would hold ${escrowTokenAfter} instead of the ${args.deposit} deposit`,
      ...base,
    }
  }
  return { ok: true, reason: 'only the escrow deposit leaves the agent wallet', ...base }
}
