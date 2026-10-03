/**
 * Milestone 1 spike — proves the payment-channel mechanics Tabula builds on, end to end, on the
 * Solana Payment Sandbox (default) or a local surfpool:
 *
 *   1. open a channel whose `authorized_signer` is a Tabula-held key, NOT the payer
 *   2. sign 10 cumulative vouchers off-chain with that key
 *   3. show the program rejects a voucher signed by the payer (agent wallet) and one over deposit
 *   4. settle mid-stream (permissionless), then payee settle_and_seal with the final voucher
 *   5. distribute: payee gets the settled amount, payer gets deposit - settled back
 *
 * Run: pnpm spike            (TABULA_CLUSTER=sandbox|localnet, optional TABULA_RPC_URL)
 */
import {
  ata,
  buildDistribute,
  buildOpenChannel,
  buildSettle,
  buildSettleAndSeal,
  ChannelStatus,
  clusterFromEnv,
  createAtaIdempotentIx,
  createRpc,
  customErrorCode,
  encodeVoucherMessage,
  ephemeralKeypair,
  explorerAddressUrl,
  explorerTxUrl,
  fetchChannelView,
  ownerTokenBalance,
  sendAndConfirm,
  setSolBalance,
  setTokenBalance,
  signVoucher,
  simulate,
  verifyVoucher,
} from '@tabula/solana'

const DEPOSIT = 1_000_000n // 1.00 USDC (6 decimals)
const UNIT_PRICE = 25_000n // 0.025 USDC per voucher step
const VOUCHERS = 10
const START_BALANCE = 5_000_000n

const cluster = clusterFromEnv()
if (!cluster.cheatcodes || !cluster.defaultMint) {
  throw new Error(
    'The spike funds accounts with surfnet cheatcodes; run it with TABULA_CLUSTER=sandbox or localnet',
  )
}
const mint = cluster.defaultMint
const rpc = createRpc(cluster.rpcUrl)
const log = (...a: unknown[]) => console.log(...a)
const usd = (v: bigint) => `$${(Number(v) / 1e6).toFixed(6)}`
const txs: { step: string; sig: string }[] = []

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`SPIKE ASSERTION FAILED: ${msg}`)
  log(`  ✓ ${msg}`)
}

async function main() {
  log(`cluster: ${cluster.name} (${cluster.rpcUrl})`)
  log(`program: ${cluster.paymentChannelsProgram}  mint: ${mint}\n`)

  // Roles. Agents never hold keys; in Tabula all four of payer/voucher/operator live in the gateway.
  const payer = await ephemeralKeypair() // agent wallet (funds the escrow)
  const voucherKey = await ephemeralKeypair() // Tabula gateway voucher signer = channel authorized_signer
  const operator = await ephemeralKeypair() // fee + rent payer
  const payee = await ephemeralKeypair() // vendor
  log(`payer (agent wallet)     ${payer.address}`)
  log(`authorized signer (Tabula) ${voucherKey.address}`)
  log(`operator (fee/rent)      ${operator.address}`)
  log(`payee (vendor)           ${payee.address}\n`)

  log('1. fund via surfnet cheatcodes')
  await setSolBalance(cluster.rpcUrl, operator.address, 10_000_000_000n)
  await setSolBalance(cluster.rpcUrl, payee.address, 1_000_000_000n)
  await setTokenBalance(cluster.rpcUrl, payer.address, mint, START_BALANCE)
  check(
    (await ownerTokenBalance(rpc, payer.address, mint)) === START_BALANCE,
    `payer funded with ${usd(START_BALANCE)}`,
  )

  log('\n2. open channel (authorized_signer = Tabula key, deposit 1.00, grace 60s)')
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send()
  const open = await buildOpenChannel({
    cluster,
    payer,
    rentPayer: operator,
    payee: payee.address,
    mint,
    authorizedSigner: voucherKey.address,
    deposit: DEPOSIT,
    gracePeriodSeconds: 60,
    openSlot: slot,
  })
  const openSig = await sendAndConfirm(rpc, {
    feePayer: operator,
    instructions: [await createAtaIdempotentIx(operator, payee.address, mint), open.instruction],
  })
  txs.push({ step: 'open', sig: openSig })
  const opened = await fetchChannelView(rpc, open.channel)
  check(opened.status === ChannelStatus.Open, `channel ${open.channel} is OPEN`)
  check(opened.deposit === DEPOSIT, `deposit is ${usd(DEPOSIT)}`)
  check(opened.data?.authorizedSigner === voucherKey.address, 'onchain authorized_signer is the Tabula key')
  check(opened.data?.payer === payer.address, 'onchain payer is the agent wallet (a different key)')
  check(
    (await ownerTokenBalance(rpc, payer.address, mint)) === START_BALANCE - DEPOSIT,
    'deposit left the payer wallet into escrow',
  )

  log(`\n3. sign ${VOUCHERS} cumulative vouchers off-chain`)
  const vouchers = []
  for (let i = 1; i <= VOUCHERS; i++) {
    const signed = await signVoucher(voucherKey, {
      channelId: open.channel,
      cumulativeAmount: UNIT_PRICE * BigInt(i),
      expiresAt: 0n,
    })
    if (!(await verifyVoucher(signed))) throw new Error(`voucher ${i} failed local verification`)
    vouchers.push(signed)
  }
  check(
    vouchers.length === VOUCHERS,
    `${VOUCHERS} vouchers signed and verified, final cumulative ${usd(UNIT_PRICE * 10n)}`,
  )

  log('\n4. negative checks (simulated, never sent)')
  const payerSigned = await signVoucher(payer, {
    channelId: open.channel,
    cumulativeAmount: 500_000n,
    expiresAt: 0n,
  })
  const sim1 = await simulate(rpc, operator, buildSettle(cluster, open.channel, payerSigned))
  check(
    customErrorCode(sim1.err)?.code === 237,
    'voucher signed by the payer/agent key is rejected (VoucherSignerMismatch 237)',
  )
  const over = await signVoucher(voucherKey, {
    channelId: open.channel,
    cumulativeAmount: DEPOSIT + 1n,
    expiresAt: 0n,
  })
  const sim2 = await simulate(rpc, operator, buildSettle(cluster, open.channel, over))
  check(
    customErrorCode(sim2.err)?.code === 235,
    'voucher above the deposit is rejected (VoucherOverDeposit 235)',
  )

  log('\n5. permissionless settle at voucher #5')
  const v5 = vouchers[4]!
  const settleSig = await sendAndConfirm(rpc, {
    feePayer: operator,
    instructions: buildSettle(cluster, open.channel, v5),
  })
  txs.push({ step: 'settle #5', sig: settleSig })
  const mid = await fetchChannelView(rpc, open.channel)
  check(mid.settled === v5.voucher.cumulativeAmount, `onchain settled watermark = ${usd(mid.settled)}`)
  const replay = await simulate(rpc, operator, buildSettle(cluster, open.channel, vouchers[2]!))
  check(
    customErrorCode(replay.err)?.code === 234,
    'older voucher cannot move the watermark back (VoucherWatermarkNotMonotonic 234)',
  )

  log('\n6. payee settle_and_seal with the final voucher #10')
  const v10 = vouchers[VOUCHERS - 1]!
  const sealSig = await sendAndConfirm(rpc, {
    feePayer: payee,
    instructions: buildSettleAndSeal(cluster, payee, open.channel, v10),
  })
  txs.push({ step: 'settle_and_seal #10', sig: sealSig })
  const sealed = await fetchChannelView(rpc, open.channel)
  check(sealed.status === ChannelStatus.Sealed, 'channel is SEALED')
  check(sealed.settled === v10.voucher.cumulativeAmount, `final settled = ${usd(sealed.settled)}`)

  log('\n7. distribute (payout to payee, refund to payer, close escrow)')
  const distribute = await buildDistribute(cluster, {
    channel: open.channel,
    payer: sealed.data!.payer,
    payee: sealed.data!.payee,
    mint,
    rentPayer: sealed.data!.rentPayer,
  })
  const distSig = await sendAndConfirm(rpc, {
    feePayer: operator,
    instructions: [await createAtaIdempotentIx(operator, cluster.treasuryOwner, mint), distribute],
  })
  txs.push({ step: 'distribute', sig: distSig })
  const after = await fetchChannelView(rpc, open.channel)
  const payerBal = await ownerTokenBalance(rpc, payer.address, mint)
  const payeeBal = await ownerTokenBalance(rpc, payee.address, mint)
  check(payeeBal === v10.voucher.cumulativeAmount, `payee received ${usd(payeeBal)}`)
  check(
    payerBal === START_BALANCE - v10.voucher.cumulativeAmount,
    `payer refunded; wallet now ${usd(payerBal)}`,
  )
  check(after.statusName === 'distributed' || after.statusName === 'closed', `channel is ${after.statusName}`)
  check(
    (await rpc.getBalance(await ata(open.channel, mint)).send()).value === 0n,
    'escrow token account closed',
  )

  log('\nTransactions:')
  for (const t of txs) log(`  ${t.step.padEnd(22)} ${explorerTxUrl(cluster, t.sig)}`)
  log(`  channel                ${explorerAddressUrl(cluster, open.channel)}`)
  log(`\nvoucher #10 message (hex): ${Buffer.from(encodeVoucherMessage(v10.voucher)).toString('hex')}`)
  log('\nSPIKE PASSED')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
