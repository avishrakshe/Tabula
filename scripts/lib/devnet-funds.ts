/**
 * What the devnet deployment's wallets should hold, and the top-ups that get them there. Shared by
 * setup (first time) and refuel (whenever the site's funds watchdog says a live run can't start).
 * Devnet SOL and Tabula's own test USDC only: no real funds.
 */
import type { Address, KeyPairSigner } from '@solana/kit'
import {
  loadOrCreateKeypair,
  mintTestTokens,
  ownerTokenBalance,
  type SolanaRpc,
  sendAndConfirm,
  solBalance,
  transferSolIx,
} from '@tabula/solana'

export const SOL = 1_000_000_000n
/** The treasury vault's test USDC ($1,000). */
export const VAULT_USDC = 1_000_000_000n
/** The operator pays Tabula's fees and funds everyone else: below this, setup stops and refuel warns. */
export const OPERATOR_MIN = (SOL * 6n) / 5n

/** SOL each wallet is topped up to from the operator (fees and rent; vendors sponsor opens). */
export const DEVNET_SOL_TARGETS: readonly (readonly [string, bigint])[] = [
  ['tabula-admin', SOL / 5n],
  ['vendor-inference-a-operator', (SOL * 3n) / 10n],
  ['vendor-inference-b-operator', (SOL * 3n) / 10n],
  ['vendor-mirror-operator', SOL / 10n],
  // the payee signs and pays for the vendor's own settle_and_seal + distribute
  ['vendor-inference-a-payee', SOL / 20n],
  ['vendor-inference-b-payee', SOL / 20n],
  ['vendor-mirror-payee', SOL / 50n],
]

/** Tops every wallet below 80% of its target back up to it, in one transaction from the operator. */
export async function topUpWallets(
  rpc: SolanaRpc,
  operator: KeyPairSigner,
): Promise<{ wallets: number; sol: bigint; signature?: string }> {
  const ixs = []
  let sol = 0n
  for (const [name, target] of DEVNET_SOL_TARGETS) {
    const k = await loadOrCreateKeypair(name)
    const have = await solBalance(rpc, k.address)
    if (have < (target * 4n) / 5n) {
      ixs.push(transferSolIx(operator, k.address, target - have))
      sol += target - have
    }
  }
  if (!ixs.length) return { wallets: 0, sol: 0n }
  const signature = await sendAndConfirm(rpc, { feePayer: operator, instructions: ixs })
  return { wallets: ixs.length, sol, signature }
}

/** Mints the vault back up to $1,000 of test USDC and gives it SOL for the accounts it pays rent on. */
export async function refillVault(
  rpc: SolanaRpc,
  operator: KeyPairSigner,
  mint: Address,
  vault: Address,
): Promise<{ minted: bigint; mintSignature?: string; solSignature?: string }> {
  const out: { minted: bigint; mintSignature?: string; solSignature?: string } = { minted: 0n }
  const held = await ownerTokenBalance(rpc, vault, mint)
  if (held < VAULT_USDC) {
    out.minted = VAULT_USDC - held
    out.mintSignature = await mintTestTokens(rpc, {
      payer: operator,
      authority: operator,
      mint,
      owner: vault,
      amount: out.minted,
    })
  }
  if ((await solBalance(rpc, vault)) < SOL / 25n) {
    out.solSignature = await sendAndConfirm(rpc, {
      feePayer: operator,
      instructions: [transferSolIx(operator, vault, SOL / 20n)],
    })
  }
  return out
}
