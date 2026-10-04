import type { ChannelState } from '@solana/mpp/server'
import { openLedger } from '@tabula/ledger'
import { describe, expect, it } from 'vitest'
import { createPostgresSessionStore } from '../src/pg-store.js'

const channel = (id: string, over: Partial<ChannelState> = {}): ChannelState => ({
  authorizedSigner: 'Signer1111111111111111111111111111111111111',
  channelId: id,
  committedDeliveries: [],
  cumulative: 0n,
  deposit: 500_000n,
  nextDeliverySequence: 0n,
  payer: 'Payer11111111111111111111111111111111111111',
  pendingDeliveries: [],
  processedUses: [],
  rentPayer: 'Payer11111111111111111111111111111111111111',
  sealed: false,
  settledOnChain: 0n,
  spentAmount: 0n,
  schemaVersion: 1,
  ...over,
})

// a cold PGlite (WASM Postgres) start plus migrations takes a few seconds
describe('Postgres SessionStore (MPP vendor state for serverless)', { timeout: 30_000 }, () => {
  it('round-trips state exactly, applies concurrent updates atomically, filters, seals and deletes', async () => {
    const ledger = await openLedger(':memory:')
    const store = createPostgresSessionStore(ledger.db, 'inference-a')
    const other = createPostgresSessionStore(ledger.db, 'inference-b')

    expect(await store.getChannel('ch1')).toBeUndefined()
    await store.updateChannel('ch1', () => channel('ch1', { deposit: 9_007_199_254_740_993n }))
    const read = await store.getChannel('ch1')
    expect(read?.deposit).toBe(9_007_199_254_740_993n) // beyond 2^53: kept as an exact bigint
    expect(typeof read?.cumulative).toBe('bigint')

    // 20 concurrent vouchers on one channel: each read-modify-write sees the previous one
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.updateChannel('ch1', (cur) => ({ ...cur!, cumulative: cur!.cumulative + 1_000n })),
      ),
    )
    expect((await store.getChannel('ch1'))?.cumulative).toBe(20_000n)

    // a failing mutator leaves the record untouched
    await expect(
      store.updateChannel('ch1', () => {
        throw new Error('bad voucher')
      }),
    ).rejects.toThrow('bad voucher')
    expect((await store.getChannel('ch1'))?.cumulative).toBe(20_000n)

    // unknown fields round-trip verbatim
    await store.updateChannel('ch2', () => ({ ...channel('ch2'), futureField: 'kept' }) as ChannelState)
    expect((await store.getChannel('ch2')) as unknown as { futureField: string }).toMatchObject({
      futureField: 'kept',
    })

    await store.updateChannel('ch3', () => channel('ch3', { closeRequestedAt: 1_700_000_000n }))
    await store.markSealed('ch2')
    await expect(store.markSealed('missing')).rejects.toThrow(/not found/)
    expect((await store.listChannels()).map((c) => c.channelId).sort()).toEqual(['ch1', 'ch2', 'ch3'])
    expect((await store.listChannels({ sealed: true })).map((c) => c.channelId)).toEqual(['ch2'])
    expect((await store.listChannels({ closePending: true })).map((c) => c.channelId)).toEqual(['ch3'])

    // vendors are isolated from each other
    expect(await other.getChannel('ch1')).toBeUndefined()
    await store.deleteChannel('ch1')
    expect(await store.getChannel('ch1')).toBeUndefined()

    // a record from a newer SDK is refused rather than silently downgraded
    await store.updateChannel('ch4', () => channel('ch4', { schemaVersion: 99 }))
    await expect(store.getChannel('ch4')).rejects.toThrow(/newer SDK/)
    await ledger.close()
  })
})
