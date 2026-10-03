import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Address, address } from '@solana/kit'
import type { SessionChallenge } from '@solana/mpp/client'
import { encodeVoucherMessage, resolveCluster, signatureFromBase58, verifyVoucher } from '@tabula/solana'
import { beforeAll, describe, expect, it } from 'vitest'
import { type RegistryVendor, verifyChallengeFields } from '../src/challenge.js'
import { Custody, GuardedVoucherSigner, issueApproval, SignerRefusal } from '../src/custody.js'
import { challengeExpiring } from '../src/mpp-client.js'
import { KeyedMutex, sleep, TimeoutError, withTimeout } from '../src/util.js'

beforeAll(() => {
  process.env.TABULA_KEYS_DIR = mkdtempSync(join(tmpdir(), 'tabula-keys-'))
})

const CHANNEL = address('GTCzQo5XXvqqgkS22WcEbVY1q7GTBf8trMTQSytMDf3b')

describe('GuardedVoucherSigner', () => {
  async function setup(deposit = 10_000n) {
    const custody = await Custody.load()
    const signer = new GuardedVoucherSigner(custody)
    signer.registerChannel(CHANNEL, 'research-01', deposit, 0n)
    const approve = (cumulative: bigint, agentId = 'research-01', channelId: string = CHANNEL) =>
      issueApproval({ agentId, sessionId: 's1', channelId, cumulative })
    return { custody, signer, approve }
  }

  it('signs an approved voucher with the agent voucher key, verifiable against the 50-byte message', async () => {
    const { custody, signer, approve } = await setup()
    const signed = await signer.sign(approve(1_000n))
    const key = (await custody.agentKeys('research-01')).voucher
    expect(signed.signer).toBe(key.address)
    expect(signed.voucher).toMatchObject({ channelId: CHANNEL, cumulativeAmount: '1000' })
    const message = encodeVoucherMessage({
      channelId: CHANNEL,
      cumulativeAmount: 1_000n,
      expiresAt: BigInt(signed.voucher.expiresAt ?? 0),
    })
    expect(
      await verifyVoucher({
        message,
        signature: signatureFromBase58(signed.signature),
        signer: key.address as Address,
      }),
    ).toBe(true)
    expect(signer.lastSigned(CHANNEL)).toBe(1_000n)
  })

  it('agent payer and voucher keys are distinct', async () => {
    const { custody } = await setup()
    const k = await custody.agentKeys('research-01')
    expect(k.payer.address).not.toBe(k.voucher.address)
    expect((await custody.agentKeys('research-01')).voucher.address).toBe(k.voucher.address)
  })

  it('refuses approvals it did not issue, and each approval works once', async () => {
    const { signer, approve } = await setup()
    const forged = Object.freeze({
      agentId: 'research-01',
      sessionId: 's1',
      channelId: CHANNEL,
      cumulative: 500n,
      issuedAt: Date.now(),
    })
    await expect(signer.sign(forged)).rejects.toThrow(SignerRefusal)
    const a = approve(500n)
    await signer.sign(a)
    await expect(signer.sign(a)).rejects.toThrow(/already used/)
  })

  it('refuses non-increasing cumulatives and anything above the deposit', async () => {
    const { signer, approve } = await setup(2_000n)
    await signer.sign(approve(1_000n))
    await expect(signer.sign(approve(1_000n))).rejects.toThrow(/strictly increase/)
    await expect(signer.sign(approve(900n))).rejects.toThrow(/strictly increase/)
    await expect(signer.sign(approve(2_001n))).rejects.toThrow(/exceed the channel deposit/)
    signer.updateDeposit(CHANNEL, 3_000n)
    signer.updateDeposit(CHANNEL, 100n) // never lowers
    await expect(signer.sign(approve(2_500n))).resolves.toBeTruthy()
  })

  it('refuses everything for a killed agent or under the global kill switch', async () => {
    const { signer, approve } = await setup()
    signer.markKilled('research-01')
    await expect(signer.sign(approve(100n))).rejects.toThrow(/stopped/)
    signer.revive('research-01')
    await expect(signer.sign(approve(100n))).resolves.toBeTruthy()
    signer.setGlobalKill(true)
    expect(signer.isKilled('anyone')).toBe(true)
    await expect(signer.sign(approve(200n))).rejects.toThrow(/stopped/)
  })

  it('refuses channels not registered to the approving agent, and expired approvals', async () => {
    const { signer, approve } = await setup()
    await expect(signer.sign(approve(100n, 'coder-01'))).rejects.toThrow(/not registered/)
    signer.forgetChannel(CHANNEL)
    await expect(signer.sign(approve(100n))).rejects.toThrow(/not registered/)
    signer.registerChannel(CHANNEL, 'research-01', 10_000n, 0n)
    const stale = approve(100n)
    const realNow = Date.now
    Date.now = () => realNow() + 10_000
    try {
      await expect(signer.sign(stale)).rejects.toThrow(/expired/)
    } finally {
      Date.now = realNow
    }
  })
})

describe('verifyChallengeFields', () => {
  const cluster = resolveCluster('sandbox')
  const vendor: RegistryVendor = {
    id: 'inference-a',
    name: 'Inference A',
    payeePubkey: 'AXcqxHZotbHaZ2EY18bJHCS8JkNRGHQ1VrKygoRvP9XP',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    programId: cluster.paymentChannelsProgram,
    unitPrice: 2,
    maxUnitPrice: 4,
    unitName: 'token',
    allowlisted: true,
  }
  const good = (
    over: Record<string, unknown> = {},
    details: Record<string, unknown> = {},
  ): SessionChallenge =>
    ({
      id: 'c1',
      intent: 'session',
      method: 'solana',
      realm: 'r',
      request: {
        amount: '1000',
        currency: vendor.mint,
        recipient: vendor.payeePubkey,
        methodDetails: {
          channelProgram: cluster.paymentChannelsProgram,
          network: 'localnet',
          feePayer: true,
          feePayerKey: '621coSPchMwckHgQAiZHG1EUj7JV7hHGmTnCmAeSoumA',
          voucherSigner: 'client',
          ...details,
        },
        ...over,
      },
    }) as unknown as SessionChallenge

  it('accepts a challenge that matches the registry and infers units per call', () => {
    expect(verifyChallengeFields(good(), vendor, cluster, 'inference-a')).toMatchObject({
      verdict: 'OK',
      unitsPerCall: 500,
      priceOffered: 1000n,
    })
  })

  it.each([
    ['UNKNOWN_VENDOR', good(), undefined],
    ['PAYEE_MISMATCH', good({ recipient: '9h5FPG2PJZnPHKTxiaupGG9KzvjMvYXJwvbXUpGKTsJF' }), vendor],
    ['MINT_MISMATCH', good({ currency: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' }), vendor],
    ['PROGRAM_MISMATCH', good({}, { channelProgram: '11111111111111111111111111111111' }), vendor],
    ['NETWORK_MISMATCH', good({}, { network: 'mainnet' }), vendor],
    ['PRICE_MISMATCH', good({ amount: '1001' }), vendor],
    ['PRICE_MISMATCH', good({ amount: 'lots' }), vendor],
    ['SPLITS_MISMATCH', good({}, { distributionSplits: [{ recipient: 'x', shareBps: 100 }] }), vendor],
    ['SIGNER_MODE_MISMATCH', good({}, { voucherSigner: 'operator' }), vendor],
    ['FEE_PAYER_MISMATCH', good({}, { feePayer: false }), vendor],
  ] as const)('%s', (verdict, challenge, v) => {
    const r = verifyChallengeFields(challenge, v, cluster, 'inference-a')
    expect(r.verdict).toBe(verdict)
    expect(r.reason.length).toBeGreaterThan(10)
  })

  it('explains payee swaps in plain language', () => {
    const r = verifyChallengeFields(
      good({ recipient: '9h5FPG2PJZnPHKTxiaupGG9KzvjMvYXJwvbXUpGKTsJF' }),
      vendor,
      cluster,
      'inference-a',
    )
    expect(r.reason).toBe(
      'the payment request names payee 9h5F…TsJF, but Inference A is registered to AXcq…P9XP',
    )
  })

  it('rejects non-session challenges', () => {
    const c = { ...good(), intent: 'charge' } as unknown as SessionChallenge
    expect(verifyChallengeFields(c, vendor, cluster, 'inference-a').verdict).toBe('NOT_A_SESSION_CHALLENGE')
  })

  it('knows when a challenge is about to expire', () => {
    const soon = {
      ...good(),
      expires: new Date(Date.now() + 10_000).toISOString(),
    } as unknown as SessionChallenge
    const later = {
      ...good(),
      expires: new Date(Date.now() + 120_000).toISOString(),
    } as unknown as SessionChallenge
    expect(challengeExpiring(soon)).toBe(true)
    expect(challengeExpiring(later)).toBe(false)
    expect(challengeExpiring(good())).toBe(false)
  })
})

describe('util', () => {
  it('KeyedMutex serializes per key and runs keys concurrently', async () => {
    const m = new KeyedMutex()
    const log: string[] = []
    const task = (key: string, id: string, ms: number) =>
      m.run(key, async () => {
        log.push(`${id}:start`)
        await sleep(ms)
        log.push(`${id}:end`)
      })
    await Promise.all([task('a', 'a1', 30), task('a', 'a2', 1), task('b', 'b1', 5)])
    expect(log.indexOf('a1:end')).toBeLessThan(log.indexOf('a2:start'))
    expect(log.indexOf('b1:start')).toBeLessThan(log.indexOf('a1:end'))
  })

  it('KeyedMutex keeps going after a failure', async () => {
    const m = new KeyedMutex()
    await expect(m.run('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(m.run('k', async () => 42)).resolves.toBe(42)
  })

  it('withTimeout aborts slow work', async () => {
    await expect(
      withTimeout(
        20,
        (signal) =>
          new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))),
      ),
    ).rejects.toThrow(TimeoutError)
    await expect(withTimeout(1000, async () => 'fast')).resolves.toBe('fast')
  })
})
