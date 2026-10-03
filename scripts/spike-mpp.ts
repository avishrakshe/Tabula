/**
 * Milestone 2 spike — the real MPP session wire protocol between a buyer that keeps the voucher key
 * separate from the payer (Tabula's model) and a vendor running the stock `@solana/mpp` session server
 * (the same code @solana/pay-kit 0.13 embeds).
 *
 *   GET /infer            -> 402 + WWW-Authenticate: Payment (session challenge)
 *   open credential       -> vendor co-signs as fee payer and broadcasts the open
 *   voucher credential x10 -> vendor verifies off-chain and serves
 *   close credential      -> vendor settle_and_seal + distribute onchain
 *
 * Run: pnpm tsx scripts/spike-mpp.ts
 */
import { serve } from '@hono/node-server'
import { createSolanaRpc } from '@solana/kit'
import {
  ActiveSession,
  buildOpenPaymentChannelTransaction,
  selectSolanaSessionChallengeFromResponse,
  serializeSessionCredential,
} from '@solana/mpp/client'
import { Mppx, session } from '@solana/mpp/server'
import {
  clusterFromEnv,
  createRpc,
  ephemeralKeypair,
  explorerTxUrl,
  fetchChannelView,
  ownerTokenBalance,
  setSolBalance,
  setTokenBalance,
} from '@tabula/solana'
import { Hono } from 'hono'

const cluster = clusterFromEnv()
if (!cluster.cheatcodes || !cluster.defaultMint) throw new Error('needs sandbox/localnet cheatcodes')
const mint = cluster.defaultMint
const rpc = createRpc(cluster.rpcUrl)
const PRICE = 1_000n // 0.001 USDC per request
const DEPOSIT = 200_000n
const PORT = 4801
const log = console.log

if (process.env.SPIKE_DEBUG_RPC) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const res = await realFetch(input, init)
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (href.startsWith(cluster.rpcUrl)) {
      const text = await res.clone().text()
      if (text.includes('"error"'))
        log(`RPC ERROR <- ${String(init?.body).slice(0, 400)}\n   -> ${text.slice(0, 600)}`)
    }
    return res
  }
}

async function main() {
  const vendorPayee = await ephemeralKeypair()
  const vendorOperator = await ephemeralKeypair()
  const payer = await ephemeralKeypair()
  const tabulaVoucherKey = await ephemeralKeypair()
  await setSolBalance(cluster.rpcUrl, vendorOperator.address, 5_000_000_000n)
  await setSolBalance(cluster.rpcUrl, vendorPayee.address, 1_000_000_000n)
  await setTokenBalance(cluster.rpcUrl, payer.address, mint, 1_000_000n)
  await setTokenBalance(cluster.rpcUrl, vendorPayee.address, mint, 0n)

  // ---- vendor: stock @solana/mpp session server --------------------------------------------
  const method = session({
    amount: PRICE,
    currency: mint,
    decimals: 6,
    feePayer: true,
    feePayerSigner: vendorOperator,
    gracePeriodSeconds: 60,
    idleTimeoutSeconds: 600,
    network: 'localnet',
    recipient: vendorPayee.address,
    rpc: createSolanaRpc(cluster.rpcUrl),
    signer: vendorPayee,
    suggestedDeposit: DEPOSIT,
    unitType: 'inference-call',
  })
  const secretKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
  const mppx = Mppx.create({ methods: [method], realm: 'spike-vendor', secretKey })
  const gate = mppx.session({
    amount: PRICE.toString(),
    currency: mint,
    description: 'inference call',
    methodDetails: { channelProgram: cluster.paymentChannelsProgram, network: 'localnet' },
    recipient: vendorPayee.address,
  })
  const app = new Hono()
  let served = 0
  app.get('/infer', async (c) => {
    const result = (await gate(c.req.raw)) as
      | { status: 402; challenge: Response }
      | { status: 200; withReceipt: (r: Response) => Response }
    if (result.status === 402) return result.challenge
    served++
    return result.withReceipt(Response.json({ completion: `token-${served}` }))
  })
  const server = serve({ fetch: app.fetch, port: PORT })
  const url = `http://127.0.0.1:${PORT}/infer`

  try {
    // ---- buyer ------------------------------------------------------------------------------
    const first = await fetch(url)
    log(`1. GET /infer -> ${first.status}`)
    const challenge = selectSolanaSessionChallengeFromResponse(first)
    if (!challenge) throw new Error('no solana session challenge in 402')
    log('   challenge.request:', JSON.stringify(challenge.request))

    const open = await buildOpenPaymentChannelTransaction({
      authorizedSigner: tabulaVoucherKey.address,
      deposit: DEPOSIT,
      request: challenge.request,
      signer: payer,
    })
    const active = new ActiveSession({ channelId: open.channelId, signer: tabulaVoucherKey })
    const openPayload = active.openPaymentChannelAction({
      authorizedSigner: tabulaVoucherKey.address,
      depositAmount: open.deposit,
      distributionSplits: challenge.request.methodDetails.distributionSplits,
      gracePeriodSeconds: open.gracePeriod,
      mint: open.mint,
      openSlot: open.openSlot,
      payee: open.payee,
      payer: open.payer,
      salt: open.salt,
      transaction: open.transaction,
    })
    const opened = await fetch(url, {
      headers: { Authorization: serializeSessionCredential({ challenge, payload: openPayload }) },
    })
    log(`2. open credential -> ${opened.status} ${await opened.text()}`)
    log(`   receipt: ${opened.headers.get('payment-receipt')?.slice(0, 60)}…`)
    const view = await fetchChannelView(rpc, open.channelId as never)
    log(
      `   onchain: ${view.statusName}, deposit ${view.deposit}, authorized_signer ${view.data?.authorizedSigner}`,
    )

    for (let i = 1; i <= 10; i++) {
      const voucher = await active.signIncrement(PRICE)
      const res = await fetch(url, {
        headers: {
          Authorization: serializeSessionCredential({
            challenge,
            payload: { action: 'voucher', channelId: open.channelId, voucher },
          }),
        },
      })
      const body = await res.text()
      if (res.status !== 200) throw new Error(`voucher ${i} -> ${res.status} ${body}`)
      if (i === 1 || i === 10)
        log(`3. voucher #${i} cumulative ${voucher.voucher.cumulativeAmount} -> ${res.status} ${body}`)
    }

    const closePayload = await active.closeAction(PRICE)
    const closed = await fetch(url, {
      headers: { Authorization: serializeSessionCredential({ challenge, payload: closePayload }) },
    })
    const receiptHeader = closed.headers.get('payment-receipt')
    const receipt = receiptHeader
      ? JSON.parse(Buffer.from(receiptHeader, 'base64url').toString('utf8'))
      : null
    log(`4. close credential -> ${closed.status}`, receipt)
    const after = await fetchChannelView(rpc, open.channelId as never)
    log(`   onchain after close: ${after.statusName} settled=${after.settled}`)
    log(`   payee balance ${await ownerTokenBalance(rpc, vendorPayee.address, mint)}`)
    log(`   payer balance ${await ownerTokenBalance(rpc, payer.address, mint)}`)
    if (receipt?.txHash) log(`   ${explorerTxUrl(cluster, receipt.txHash)}`)
    log('\nMPP SPIKE DONE')
  } finally {
    server.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
