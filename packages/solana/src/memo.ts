import {
  AccountRole,
  type AccountSignerMeta,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type TransactionSigner,
} from '@solana/kit'
import { MEMO_PROGRAM } from './cluster.js'
import type { SolanaRpc } from './rpc.js'

/**
 * SPL Memo instruction: data is the UTF-8 memo, accounts are the signers that vouch for it.
 * (Built directly because @solana-program/memo >= 0.12 requires @solana/kit >= 7.)
 */
export function buildMemoInstruction(
  memo: string,
  signer: TransactionSigner,
): Instruction & InstructionWithAccounts<[AccountSignerMeta]> & InstructionWithData<Uint8Array> {
  const data = new TextEncoder().encode(memo)
  if (data.byteLength > 566) throw new Error(`memo too long: ${data.byteLength} bytes`)
  const account: AccountSignerMeta = { address: signer.address, role: AccountRole.READONLY_SIGNER, signer }
  return { programAddress: MEMO_PROGRAM, accounts: [account], data }
}

/** Reads back the memo strings a confirmed transaction carried (from its memo instructions). */
export async function fetchTransactionMemos(rpc: SolanaRpc, signature: string): Promise<string[]> {
  const tx = await rpc
    .getTransaction(signature as never, {
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    })
    .send()
  if (!tx) return []
  const memos: string[] = []
  const ixs = (
    tx.transaction.message as unknown as { instructions: { programId: string; parsed?: unknown }[] }
  ).instructions
  for (const ix of ixs) {
    if (ix.programId === MEMO_PROGRAM && typeof ix.parsed === 'string') memos.push(ix.parsed)
  }
  if (memos.length === 0) {
    // fall back to the program log ("Program log: Memo (len N): \"...\"")
    for (const line of tx.meta?.logMessages ?? []) {
      const m = /Memo \(len \d+\): "(.*)"$/.exec(line)
      if (m?.[1]) memos.push(m[1].replace(/\\"/g, '"'))
    }
  }
  return memos
}
