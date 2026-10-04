/**
 * Devnet has no cheatcodes: SOL comes from the faucet (rate-limited) and moves between our own wallets,
 * and the escrow token is a test mint Tabula creates (Circle's devnet USDC is faucet-gated). It is a
 * classic SPL Token mint with 6 decimals, which @solana/mpp accepts as a currency address.
 */
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  lamports,
  type TransactionSigner,
} from '@solana/kit'
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system'
import {
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
} from '@solana-program/token'
import { TOKEN_PROGRAM } from './cluster.js'
import { type SolanaRpc, sendAndConfirm, sleep } from './rpc.js'
import { ata, createAtaIdempotentIx } from './token.js'

export const TEST_USDC_DECIMALS = 6

export async function solBalance(rpc: SolanaRpc, owner: Address): Promise<bigint> {
  return (await rpc.getBalance(owner, { commitment: 'confirmed' }).send()).value
}

/** Asks the devnet faucet for SOL and waits for it to land. Throws when the faucet refuses (it often does). */
export async function airdrop(
  rpc: SolanaRpc,
  to: Address,
  amount: bigint,
  timeoutMs = 60_000,
): Promise<string> {
  const before = await solBalance(rpc, to)
  const signature = await rpc.requestAirdrop(to, lamports(amount), { commitment: 'confirmed' }).send()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await solBalance(rpc, to)) > before) return signature
    await sleep(1_500)
  }
  throw new Error(`airdrop ${signature} did not land within ${timeoutMs / 1000}s`)
}

export function transferSolIx(from: TransactionSigner, to: Address, amount: bigint): Instruction {
  return getTransferSolInstruction({ source: from, destination: to, amount })
}

/** Creates the test mint (address = `mint` keypair) with `authority` as mint authority, unless it exists. */
export async function ensureTestMint(
  rpc: SolanaRpc,
  payer: KeyPairSigner,
  mint: KeyPairSigner,
  authority: Address,
): Promise<{ created: boolean; signature?: string }> {
  const { value } = await rpc.getAccountInfo(mint.address, { encoding: 'base64' }).send()
  if (value) return { created: false }
  const space = BigInt(getMintSize())
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send()
  const signature = await sendAndConfirm(rpc, {
    feePayer: payer,
    instructions: [
      getCreateAccountInstruction({
        payer,
        newAccount: mint,
        lamports: rent,
        space,
        programAddress: TOKEN_PROGRAM,
      }),
      getInitializeMint2Instruction({
        mint: mint.address,
        decimals: TEST_USDC_DECIMALS,
        mintAuthority: authority,
      }),
    ],
  })
  return { created: true, signature }
}

/** Mints test tokens to `owner`'s associated token account (created if missing). */
export async function mintTestTokens(
  rpc: SolanaRpc,
  args: { payer: KeyPairSigner; authority: KeyPairSigner; mint: Address; owner: Address; amount: bigint },
): Promise<string> {
  const destination = await ata(args.owner, args.mint)
  return sendAndConfirm(rpc, {
    feePayer: args.payer,
    instructions: [
      await createAtaIdempotentIx(args.payer, args.owner, args.mint),
      getMintToCheckedInstruction({
        mint: args.mint,
        token: destination,
        mintAuthority: args.authority,
        amount: args.amount,
        decimals: TEST_USDC_DECIMALS,
      }),
    ],
  })
}
