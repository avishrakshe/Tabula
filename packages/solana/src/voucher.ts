import {
  type Address,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getPublicKeyFromAddress,
  type Instruction,
  type KeyPairSigner,
  type SignatureBytes,
  signBytes,
  verifySignature,
} from '@solana/kit'

/**
 * Payment-channel voucher wire format (program README, "Voucher wire format"):
 *
 * | offset | size | field             | encoding                  |
 * | 0..2   | 2    | magic             | [0x56, 0x01]              |
 * | 2..34  | 32   | channel_id        | channel PDA bytes         |
 * | 34..42 | 8    | cumulative_amount | u64 LE                    |
 * | 42..50 | 8    | expires_at        | i64 LE, 0 disables expiry |
 */
export const VOUCHER_MAGIC = Uint8Array.of(0x56, 0x01)
export const VOUCHER_MESSAGE_LENGTH = 50
export const ED25519_PROGRAM = 'Ed25519SigVerify111111111111111111111111111' as Address

const U64_MAX = (1n << 64n) - 1n
const I64_MIN = -(1n << 63n)
const I64_MAX = (1n << 63n) - 1n

export interface Voucher {
  readonly channelId: Address
  readonly cumulativeAmount: bigint
  /** Unix seconds; 0 disables expiry. */
  readonly expiresAt: bigint
}

export interface SignedVoucherBytes {
  readonly voucher: Voucher
  readonly message: Uint8Array
  readonly signature: SignatureBytes
  readonly signer: Address
}

export function encodeVoucherMessage(voucher: Voucher): Uint8Array {
  if (voucher.cumulativeAmount < 0n || voucher.cumulativeAmount > U64_MAX) {
    throw new RangeError(`cumulativeAmount out of u64 range: ${voucher.cumulativeAmount}`)
  }
  if (voucher.expiresAt < I64_MIN || voucher.expiresAt > I64_MAX) {
    throw new RangeError(`expiresAt out of i64 range: ${voucher.expiresAt}`)
  }
  const out = new Uint8Array(VOUCHER_MESSAGE_LENGTH)
  out.set(VOUCHER_MAGIC, 0)
  out.set(getAddressEncoder().encode(voucher.channelId), 2)
  const view = new DataView(out.buffer)
  view.setBigUint64(34, voucher.cumulativeAmount, true)
  view.setBigInt64(42, voucher.expiresAt, true)
  return out
}

export function decodeVoucherMessage(message: Uint8Array): Voucher {
  if (message.byteLength !== VOUCHER_MESSAGE_LENGTH) {
    throw new Error(`voucher message must be ${VOUCHER_MESSAGE_LENGTH} bytes, got ${message.byteLength}`)
  }
  if (message[0] !== VOUCHER_MAGIC[0] || message[1] !== VOUCHER_MAGIC[1]) {
    throw new Error('voucher message has bad magic')
  }
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength)
  return {
    channelId: getBase58Decoder().decode(message.subarray(2, 34)) as Address,
    cumulativeAmount: view.getBigUint64(34, true),
    expiresAt: view.getBigInt64(42, true),
  }
}

/** Signs the canonical 50-byte voucher message with the channel's authorized signer key. */
export async function signVoucher(signer: KeyPairSigner, voucher: Voucher): Promise<SignedVoucherBytes> {
  const message = encodeVoucherMessage(voucher)
  const signature = await signBytes(signer.keyPair.privateKey, message)
  return { voucher, message, signature, signer: signer.address }
}

export async function verifyVoucher(signed: Pick<SignedVoucherBytes, 'message' | 'signature' | 'signer'>) {
  const key = await getPublicKeyFromAddress(signed.signer)
  return verifySignature(key, signed.signature, signed.message)
}

export function signatureToBase58(signature: SignatureBytes | Uint8Array): string {
  return getBase58Decoder().decode(signature)
}

export function signatureFromBase58(signature: string): SignatureBytes {
  const bytes = getBase58Encoder().encode(signature)
  if (bytes.byteLength !== 64) throw new Error(`signature must decode to 64 bytes, got ${bytes.byteLength}`)
  return bytes as SignatureBytes
}

/**
 * Canonical single-signature Ed25519 precompile instruction carrying the voucher, placed
 * immediately before `settle` / `settleAndSeal`. All offsets point into this instruction
 * (instruction index 0xffff = "current"). Layout mirrors pay-kit's `buildEd25519VerifyInstruction`
 * (MIT, solana-foundation/pay-kit typescript/packages/mpp/src/server/session/on-chain.ts).
 */
export function buildEd25519VoucherInstruction(
  signed: Pick<SignedVoucherBytes, 'message' | 'signature' | 'signer'>,
): Instruction {
  const signer = getAddressEncoder().encode(signed.signer)
  const publicKeyOffset = 16
  const signatureOffset = publicKeyOffset + 32
  const messageOffset = signatureOffset + 64
  const current = 0xffff
  const data = new Uint8Array(messageOffset + signed.message.byteLength)
  const view = new DataView(data.buffer)
  data[0] = 1 // num_signatures
  data[1] = 0 // padding
  view.setUint16(2, signatureOffset, true)
  view.setUint16(4, current, true)
  view.setUint16(6, publicKeyOffset, true)
  view.setUint16(8, current, true)
  view.setUint16(10, messageOffset, true)
  view.setUint16(12, signed.message.byteLength, true)
  view.setUint16(14, current, true)
  data.set(signer, publicKeyOffset)
  data.set(signed.signature, signatureOffset)
  data.set(signed.message, messageOffset)
  return { programAddress: ED25519_PROGRAM, accounts: [], data }
}
