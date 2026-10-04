import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { address, getAddressEncoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { deriveChannelAddress, randomSalt } from '../src/channels.js'
import { explorerAddressUrl, explorerTxUrl, publicRpcUrl, resolveCluster } from '../src/cluster.js'
import { deriveKeypair, ephemeralKeypair, loadOrCreateKeypair } from '../src/keys.js'
import { briefError, customErrorCode, TransactionFailedError } from '../src/rpc.js'
import {
  buildEd25519VoucherInstruction,
  decodeVoucherMessage,
  ED25519_PROGRAM,
  encodeVoucherMessage,
  signatureFromBase58,
  signatureToBase58,
  signVoucher,
  verifyVoucher,
} from '../src/voucher.js'

const CHANNEL = address('GTCzQo5XXvqqgkS22WcEbVY1q7GTBf8trMTQSytMDf3b')

describe('voucher wire format', () => {
  it('encodes the 50-byte message exactly as the program README specifies', () => {
    const msg = encodeVoucherMessage({ channelId: CHANNEL, cumulativeAmount: 250_000n, expiresAt: 0n })
    expect(msg.byteLength).toBe(50)
    expect([...msg.subarray(0, 2)]).toEqual([0x56, 0x01])
    expect([...msg.subarray(2, 34)]).toEqual([...getAddressEncoder().encode(CHANNEL)])
    expect(new DataView(msg.buffer).getBigUint64(34, true)).toBe(250_000n)
    expect(new DataView(msg.buffer).getBigInt64(42, true)).toBe(0n)
    expect(decodeVoucherMessage(msg)).toEqual({
      channelId: CHANNEL,
      cumulativeAmount: 250_000n,
      expiresAt: 0n,
    })
  })

  it('rejects out-of-range fields and malformed messages', () => {
    expect(() => encodeVoucherMessage({ channelId: CHANNEL, cumulativeAmount: -1n, expiresAt: 0n })).toThrow(
      RangeError,
    )
    expect(() =>
      encodeVoucherMessage({ channelId: CHANNEL, cumulativeAmount: 1n << 64n, expiresAt: 0n }),
    ).toThrow(RangeError)
    expect(() =>
      encodeVoucherMessage({ channelId: CHANNEL, cumulativeAmount: 1n, expiresAt: 1n << 63n }),
    ).toThrow(RangeError)
    expect(() => decodeVoucherMessage(new Uint8Array(49))).toThrow(/50 bytes/)
    expect(() => decodeVoucherMessage(new Uint8Array(50))).toThrow(/magic/)
  })

  it('signs and verifies; a different signer or amount does not verify', async () => {
    const key = await ephemeralKeypair()
    const other = await ephemeralKeypair()
    const signed = await signVoucher(key, { channelId: CHANNEL, cumulativeAmount: 1_000n, expiresAt: 0n })
    expect(await verifyVoucher(signed)).toBe(true)
    expect(await verifyVoucher({ ...signed, signer: other.address })).toBe(false)
    const tampered = encodeVoucherMessage({ channelId: CHANNEL, cumulativeAmount: 1_001n, expiresAt: 0n })
    expect(await verifyVoucher({ ...signed, message: tampered })).toBe(false)
    expect(signatureFromBase58(signatureToBase58(signed.signature))).toEqual(signed.signature)
    expect(() => signatureFromBase58('abc')).toThrow(/64 bytes/)
  })

  it('builds the canonical single-signature Ed25519 precompile instruction', async () => {
    const key = await ephemeralKeypair()
    const signed = await signVoucher(key, { channelId: CHANNEL, cumulativeAmount: 7n, expiresAt: 0n })
    const ix = buildEd25519VoucherInstruction(signed)
    const d = ix.data as Uint8Array
    const v = new DataView(d.buffer)
    expect(ix.programAddress).toBe(ED25519_PROGRAM)
    expect(d.byteLength).toBe(162) // matches the program docs: "canonical single-signature precompile ix: 162 bytes"
    expect(d[0]).toBe(1)
    expect([
      v.getUint16(2, true),
      v.getUint16(6, true),
      v.getUint16(10, true),
      v.getUint16(12, true),
    ]).toEqual([48, 16, 112, 50])
    expect([v.getUint16(4, true), v.getUint16(8, true), v.getUint16(14, true)]).toEqual([
      0xffff, 0xffff, 0xffff,
    ])
    expect([...d.subarray(16, 48)]).toEqual([...getAddressEncoder().encode(key.address)])
    expect([...d.subarray(112)]).toEqual([...signed.message])
  })
})

describe('channels and clusters', () => {
  it('derives the channel PDA deterministically from all seeds', async () => {
    const seeds = {
      payer: address('9h5FPG2PJZnPHKTxiaupGG9KzvjMvYXJwvbXUpGKTsJF'),
      payee: address('AXcqxHZotbHaZ2EY18bJHCS8JkNRGHQ1VrKygoRvP9XP'),
      mint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      authorizedSigner: address('AE4PqxjZuv7qSFSddXtU6LxojEYZmhLGpC696yqwgTrw'),
      salt: 42n,
      openSlot: 452_703_864n,
    }
    const program = resolveCluster('sandbox').paymentChannelsProgram
    const a = await deriveChannelAddress(seeds, program)
    expect(await deriveChannelAddress(seeds, program)).toBe(a)
    expect(await deriveChannelAddress({ ...seeds, openSlot: seeds.openSlot + 1n }, program)).not.toBe(a)
    expect(await deriveChannelAddress({ ...seeds, authorizedSigner: seeds.payer }, program)).not.toBe(a)
    expect(randomSalt()).not.toBe(randomSalt())
  })

  it('resolves clusters with the right treasury per program build and builds explorer links', () => {
    const sandbox = resolveCluster('sandbox')
    const devnet = resolveCluster('devnet')
    expect(sandbox.treasuryOwner).toBe('Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP')
    expect(devnet.treasuryOwner).toBe('4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap')
    expect(devnet.cheatcodes).toBe(false)
    expect(resolveCluster('localnet').rpcUrl).toBe('http://127.0.0.1:8899')
    expect(explorerTxUrl(devnet, 'SIG')).toBe('https://explorer.solana.com/tx/SIG?cluster=devnet')
    expect(explorerAddressUrl(sandbox, 'ADDR')).toBe(
      'https://explorer.solana.com/address/ADDR?cluster=custom&customUrl=https%3A%2F%2F402.surfnet.dev%3A8899',
    )
  })

  it('extracts custom program error codes', () => {
    expect(customErrorCode({ InstructionError: [1, { Custom: 237 }] })).toEqual({ index: 1, code: 237 })
    expect(customErrorCode({ InstructionError: [0, 'InvalidAccountData'] })).toBeNull()
    expect(customErrorCode(null)).toBeNull()
  })

  it('shows only an RPC key-free origin', () => {
    expect(publicRpcUrl('https://devnet.helius-rpc.com/?api-key=SECRET')).toBe(
      'https://devnet.helius-rpc.com',
    )
    expect(publicRpcUrl('https://solana-devnet.g.alchemy.com/v2/SECRET')).toBe(
      'https://solana-devnet.g.alchemy.com',
    )
    expect(publicRpcUrl('not a url')).toBe('unknown')
  })

  it('shortens a failed transaction to the program error, without the encoded payload', () => {
    const err = new TransactionFailedError(
      "sendTransaction failed: Solana error #-32002; Decode this error by running `npx @solana/errors decode -- -32002 'X19jb2RlPS0zMjAwMg=='` (Solana error #4615026; Decode this error by running `npx @solana/errors decode -- 4615026 'X19jb2Rl'`)",
      [
        'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]',
        'Program log: Error: insufficient funds',
        'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1',
      ],
    )
    expect(briefError(err)).toBe('sendTransaction failed: insufficient funds')
    expect(briefError(new Error('fetch failed\n  at x'))).toBe('fetch failed')
  })
})

describe('keys', () => {
  it('creates a keypair once under TABULA_KEYS_DIR and reloads the same one', async () => {
    process.env.TABULA_KEYS_DIR = mkdtempSync(join(tmpdir(), 'tabula-keys-'))
    const a = await loadOrCreateKeypair('agent-x-payer')
    const b = await loadOrCreateKeypair('agent-x-payer')
    expect(b.address).toBe(a.address)
    await expect(loadOrCreateKeypair('../escape')).rejects.toThrow(/invalid key name/)
  })

  it('derives every named key from TABULA_KEY_SEED, deterministically and distinctly', async () => {
    const seed = 'ab'.repeat(32)
    process.env.TABULA_KEY_SEED = seed
    try {
      const payer = await loadOrCreateKeypair('agent-x-payer')
      const again = await loadOrCreateKeypair('agent-x-payer')
      const voucher = await loadOrCreateKeypair('agent-x-voucher')
      expect(again.address).toBe(payer.address)
      expect(voucher.address).not.toBe(payer.address)
      // the same seed and name give the same key anywhere (a fresh instance rebuilds it)
      expect((await deriveKeypair(Buffer.from(seed, 'hex'), 'agent-x-payer')).address).toBe(payer.address)
      expect((await deriveKeypair(Buffer.from('cd'.repeat(32), 'hex'), 'agent-x-payer')).address).not.toBe(
        payer.address,
      )
      process.env.TABULA_KEY_SEED = 'not-hex'
      await expect(loadOrCreateKeypair('agent-y-payer')).rejects.toThrow(/64 hex/)
    } finally {
      delete process.env.TABULA_KEY_SEED
    }
  })
})
