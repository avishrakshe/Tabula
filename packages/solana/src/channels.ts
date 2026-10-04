import {
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  getUtf8Encoder,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit'
import {
  ASSOCIATED_TOKEN_PROGRAM,
  type ClusterConfig,
  INSTRUCTIONS_SYSVAR,
  RENT_SYSVAR,
  TOKEN_PROGRAM,
} from './cluster'
import {
  type Channel,
  ChannelStatus,
  fetchMaybeChannel,
  getDistributeInstructionAsync,
  getOpenInstructionAsync,
  getRequestCloseInstruction,
  getSealInstruction,
  getSettleAndSealInstruction,
  getSettleInstruction,
  getTopUpInstruction,
  getWithdrawPayerInstruction,
} from './generated/payment-channels/index'
import type { SolanaRpc } from './rpc'
import { ata } from './token'
import { buildEd25519VoucherInstruction, type SignedVoucherBytes } from './voucher'

export type { Channel }
export { ChannelStatus }

export interface DistributionEntry {
  readonly recipient: Address
  readonly bps: number
}

export interface ChannelSeeds {
  readonly payer: Address
  readonly payee: Address
  readonly mint: Address
  readonly authorizedSigner: Address
  readonly salt: bigint
  readonly openSlot: bigint
}

/** PDA seeds: [b"channel", payer, payee, mint, authorized_signer, salt u64 LE, open_slot u64 LE]. */
export async function deriveChannelAddress(seeds: ChannelSeeds, programAddress: Address): Promise<Address> {
  const enc = getAddressEncoder()
  const [addr] = await getProgramDerivedAddress({
    programAddress,
    seeds: [
      getUtf8Encoder().encode('channel'),
      enc.encode(seeds.payer),
      enc.encode(seeds.payee),
      enc.encode(seeds.mint),
      enc.encode(seeds.authorizedSigner),
      getU64Encoder().encode(seeds.salt),
      getU64Encoder().encode(seeds.openSlot),
    ],
  })
  return addr
}

export function randomSalt(): bigint {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return new DataView(bytes.buffer).getBigUint64(0, true)
}

export interface OpenChannelParams {
  readonly cluster: ClusterConfig
  /** Funds the deposit and is the payer-side authority (top_up, request_close, withdraw_payer). */
  readonly payer: TransactionSigner
  /** Funds PDA + escrow ATA rent; receives it back on close. May equal payer. */
  readonly rentPayer: TransactionSigner
  readonly payee: Address
  readonly mint: Address
  /** The only key whose vouchers the program accepts. Tabula's gateway holds it; the payer cannot sign. */
  readonly authorizedSigner: Address
  readonly deposit: bigint
  readonly gracePeriodSeconds: number
  /** Must satisfy openSlot <= clock.slot && clock.slot - openSlot <= 1500. */
  readonly openSlot: bigint
  readonly salt?: bigint
  readonly recipients?: readonly DistributionEntry[]
  readonly tokenProgram?: Address
}

export interface OpenChannelResult {
  readonly channel: Address
  readonly salt: bigint
  readonly instruction: Instruction
}

export async function buildOpenChannel(params: OpenChannelParams): Promise<OpenChannelResult> {
  const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM
  const programAddress = params.cluster.paymentChannelsProgram
  const salt = params.salt ?? randomSalt()
  const channel = await deriveChannelAddress(
    {
      payer: params.payer.address,
      payee: params.payee,
      mint: params.mint,
      authorizedSigner: params.authorizedSigner,
      salt,
      openSlot: params.openSlot,
    },
    programAddress,
  )
  const instruction = await getOpenInstructionAsync(
    {
      payer: params.payer,
      rentPayer: params.rentPayer,
      payee: params.payee,
      mint: params.mint,
      authorizedSigner: params.authorizedSigner,
      channel,
      payerTokenAccount: await ata(params.payer.address, params.mint, tokenProgram),
      channelTokenAccount: await ata(channel, params.mint, tokenProgram),
      tokenProgram,
      rent: RENT_SYSVAR,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM,
      selfProgram: programAddress,
      openArgs: {
        salt,
        deposit: params.deposit,
        gracePeriod: params.gracePeriodSeconds,
        openSlot: params.openSlot,
        recipients: (params.recipients ?? []).map((r) => ({ recipient: r.recipient, bps: r.bps })),
      },
    },
    { programAddress },
  )
  return { channel, salt, instruction }
}

/** Permissionless settle: Ed25519 precompile carrying the voucher, then `settle`. */
export function buildSettle(
  cluster: ClusterConfig,
  channel: Address,
  signed: Pick<SignedVoucherBytes, 'message' | 'signature' | 'signer'>,
): Instruction[] {
  return [
    buildEd25519VoucherInstruction(signed),
    getSettleInstruction(
      { channel, instructionsSysvar: INSTRUCTIONS_SYSVAR },
      { programAddress: cluster.paymentChannelsProgram },
    ),
  ]
}

/** Payee-signed cooperative close; optionally applies a final voucher first. */
export function buildSettleAndSeal(
  cluster: ClusterConfig,
  payee: TransactionSigner,
  channel: Address,
  signed?: Pick<SignedVoucherBytes, 'message' | 'signature' | 'signer'>,
): Instruction[] {
  const seal = getSettleAndSealInstruction(
    {
      payee,
      channel,
      instructionsSysvar: INSTRUCTIONS_SYSVAR,
      settleAndSealArgs: { hasVoucher: signed ? 1 : 0 },
    },
    { programAddress: cluster.paymentChannelsProgram },
  )
  return signed ? [buildEd25519VoucherInstruction(signed), seal] : [seal]
}

/** Payer-initiated forced close: OPEN -> CLOSING, starts the grace period. */
export function buildRequestClose(
  cluster: ClusterConfig,
  payer: TransactionSigner,
  channel: Address,
): Instruction {
  return getRequestCloseInstruction({ payer, channel }, { programAddress: cluster.paymentChannelsProgram })
}

/** Permissionless CLOSING -> SEALED once closure_started_at + grace_period has passed. */
export function buildSeal(cluster: ClusterConfig, channel: Address): Instruction {
  return getSealInstruction({ channel }, { programAddress: cluster.paymentChannelsProgram })
}

export async function buildTopUp(
  cluster: ClusterConfig,
  payer: TransactionSigner,
  channel: Address,
  mint: Address,
  amount: bigint,
  tokenProgram: Address = TOKEN_PROGRAM,
): Promise<Instruction> {
  return getTopUpInstruction(
    {
      payer,
      channel,
      payerTokenAccount: await ata(payer.address, mint, tokenProgram),
      channelTokenAccount: await ata(channel, mint, tokenProgram),
      mint,
      tokenProgram,
      topUpArgs: { amount },
    },
    { programAddress: cluster.paymentChannelsProgram },
  )
}

/** Payer one-shot refund of deposit - settled while SEALED (does not close the PDA). */
export async function buildWithdrawPayer(
  cluster: ClusterConfig,
  payer: TransactionSigner,
  channel: Address,
  mint: Address,
  tokenProgram: Address = TOKEN_PROGRAM,
): Promise<Instruction> {
  return getWithdrawPayerInstruction(
    {
      payer,
      channel,
      channelTokenAccount: await ata(channel, mint, tokenProgram),
      payerTokenAccount: await ata(payer.address, mint, tokenProgram),
      mint,
      tokenProgram,
    },
    { programAddress: cluster.paymentChannelsProgram },
  )
}

/**
 * Permissionless distribute. From SEALED: pays the payee its settled share, refunds the payer
 * deposit - settled (unless already withdrawn), sweeps dust to the cluster treasury, closes escrow.
 */
export async function buildDistribute(
  cluster: ClusterConfig,
  state: Pick<Channel, 'payer' | 'payee' | 'mint' | 'rentPayer'> & { readonly channel: Address },
  recipients: readonly DistributionEntry[] = [],
  tokenProgram: Address = TOKEN_PROGRAM,
): Promise<Instruction> {
  const recipientTokenAccounts = await Promise.all(
    recipients.map((r) => ata(r.recipient, state.mint, tokenProgram)),
  )
  return getDistributeInstructionAsync(
    {
      channel: state.channel,
      payer: state.payer,
      rentPayer: state.rentPayer,
      channelTokenAccount: await ata(state.channel, state.mint, tokenProgram),
      payerTokenAccount: await ata(state.payer, state.mint, tokenProgram),
      payeeTokenAccount: await ata(state.payee, state.mint, tokenProgram),
      treasuryTokenAccount: await ata(cluster.treasuryOwner, state.mint, tokenProgram),
      mint: state.mint,
      tokenProgram,
      selfProgram: cluster.paymentChannelsProgram,
      distributeArgs: { recipients: recipients.map((r) => ({ recipient: r.recipient, bps: r.bps })) },
      recipientTokenAccounts,
    },
    { programAddress: cluster.paymentChannelsProgram },
  )
}

export interface ChannelView {
  readonly address: Address
  readonly exists: boolean
  readonly status: ChannelStatus | null
  readonly statusName: 'open' | 'sealed' | 'closing' | 'distributed' | 'closed'
  readonly deposit: bigint
  readonly settled: bigint
  readonly payoutWatermark: bigint
  readonly closureStartedAt: bigint
  readonly gracePeriod: number
  readonly data: Channel | null
}

const STATUS_NAMES = ['open', 'sealed', 'closing', 'distributed'] as const

/** Reads the channel PDA. A missing account means the channel was fully closed (deallocated). */
export async function fetchChannelView(rpc: SolanaRpc, channel: Address): Promise<ChannelView> {
  const maybe = await fetchMaybeChannel(rpc, channel)
  if (!maybe.exists) {
    return {
      address: channel,
      exists: false,
      status: null,
      statusName: 'closed',
      deposit: 0n,
      settled: 0n,
      payoutWatermark: 0n,
      closureStartedAt: 0n,
      gracePeriod: 0,
      data: null,
    }
  }
  const d = maybe.data
  return {
    address: channel,
    exists: true,
    status: d.status as ChannelStatus,
    statusName: STATUS_NAMES[d.status] ?? 'closed',
    deposit: d.deposit,
    settled: d.settlement.settled,
    payoutWatermark: d.settlement.payoutWatermark,
    closureStartedAt: d.closureStartedAt,
    gracePeriod: d.gracePeriod,
    data: d,
  }
}
