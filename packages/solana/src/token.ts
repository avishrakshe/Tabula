import type { Address, Instruction, TransactionSigner } from '@solana/kit'
import {
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
} from '@solana-program/token'
import { TOKEN_PROGRAM } from './cluster.js'
import type { SolanaRpc } from './rpc.js'

export async function ata(
  owner: Address,
  mint: Address,
  tokenProgram: Address = TOKEN_PROGRAM,
): Promise<Address> {
  const [addr] = await findAssociatedTokenPda({ owner, mint, tokenProgram })
  return addr
}

/** Token balance in base units; 0n when the account does not exist. */
export async function tokenBalance(rpc: SolanaRpc, tokenAccount: Address): Promise<bigint> {
  const acct = await fetchMaybeToken(rpc, tokenAccount)
  return acct.exists ? acct.data.amount : 0n
}

export async function ownerTokenBalance(
  rpc: SolanaRpc,
  owner: Address,
  mint: Address,
  tokenProgram: Address = TOKEN_PROGRAM,
): Promise<bigint> {
  return tokenBalance(rpc, await ata(owner, mint, tokenProgram))
}

export async function createAtaIdempotentIx(
  payer: TransactionSigner,
  owner: Address,
  mint: Address,
  tokenProgram: Address = TOKEN_PROGRAM,
): Promise<Instruction> {
  return getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint, tokenProgram })
}

export async function transferCheckedIx(args: {
  readonly authority: TransactionSigner
  readonly mint: Address
  readonly destinationOwner: Address
  readonly amount: bigint
  readonly decimals: number
  readonly tokenProgram?: Address
}): Promise<Instruction> {
  const tokenProgram = args.tokenProgram ?? TOKEN_PROGRAM
  const source = await ata(args.authority.address, args.mint, tokenProgram)
  const destination = await ata(args.destinationOwner, args.mint, tokenProgram)
  return getTransferCheckedInstruction(
    {
      source,
      mint: args.mint,
      destination,
      authority: args.authority,
      amount: args.amount,
      decimals: args.decimals,
    },
    { programAddress: tokenProgram },
  )
}
