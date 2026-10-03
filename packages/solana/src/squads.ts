/**
 * Squads v4 vault helpers. The Squads SDK (`@sqds/multisig`) builds web3.js v1 instructions; we
 * convert them to @solana/kit instructions and send them through our own confirm loop, because the
 * SDK's `rpc.*` helpers do not wait for confirmation between dependent steps.
 *
 * Tabula's treasury is a Squads vault (threshold 1, the Tabula admin key as the only member in the
 * demo). Anything the vault "signs" — e.g. creating an agent's allowance — goes through a vault
 * transaction: create -> propose -> approve -> execute (the vault PDA signs inner instructions by CPI).
 */
import { AccountRole, type Address, address, type Instruction, type KeyPairSigner } from '@solana/kit'
import { Connection, PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js'
import * as squads from '@sqds/multisig'
import { type SolanaRpc, sendAndConfirm } from './rpc.js'

export const SQUADS_PROGRAM_ID = squads.PROGRAM_ID

export function kitToWeb3Instruction(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((a) => ({
      pubkey: new PublicKey(a.address),
      isSigner: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER,
      isWritable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER,
    })),
    data: Buffer.from(ix.data ?? new Uint8Array()),
  })
}

/** Converts a web3.js instruction, attaching kit signers for every signer account we hold a key for. */
export function web3ToKitInstruction(
  ix: TransactionInstruction,
  signers: readonly KeyPairSigner[] = [],
): Instruction {
  const byAddress = new Map(signers.map((s) => [s.address as string, s]))
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => {
      const addr = address(k.pubkey.toBase58())
      const role = k.isSigner
        ? k.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : k.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY
      const signer = k.isSigner ? byAddress.get(addr) : undefined
      return signer ? { address: addr, role, signer } : { address: addr, role }
    }),
    data: new Uint8Array(ix.data),
  } as Instruction
}

export interface SquadsVault {
  readonly multisig: Address
  readonly vault: Address
  readonly vaultIndex: number
}

export function vaultFor(multisig: Address, vaultIndex = 0): SquadsVault {
  const [vault] = squads.getVaultPda({ multisigPda: new PublicKey(multisig), index: vaultIndex })
  return { multisig, vault: address(vault.toBase58()), vaultIndex }
}

/** Creates a threshold-1 multisig whose only member is `admin`; returns its vault. */
export async function createSquadsVault(
  rpc: SolanaRpc,
  rpcUrl: string,
  admin: KeyPairSigner,
  createKey: KeyPairSigner,
): Promise<SquadsVault & { signature: string }> {
  const connection = new Connection(rpcUrl, 'confirmed')
  const [programConfigPda] = squads.getProgramConfigPda({})
  const programConfig = await squads.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda)
  const [multisigPda] = squads.getMultisigPda({ createKey: new PublicKey(createKey.address) })
  const adminKey = new PublicKey(admin.address)
  const ix = squads.instructions.multisigCreateV2({
    treasury: programConfig.treasury,
    creator: adminKey,
    multisigPda,
    configAuthority: null,
    threshold: 1,
    members: [{ key: adminKey, permissions: squads.types.Permissions.all() }],
    timeLock: 0,
    createKey: new PublicKey(createKey.address),
    rentCollector: adminKey,
    memo: 'Tabula treasury',
  })
  const signature = await sendAndConfirm(rpc, {
    feePayer: admin,
    instructions: [web3ToKitInstruction(ix, [admin, createKey])],
  })
  return { ...vaultFor(address(multisigPda.toBase58())), signature }
}

/**
 * Runs `instructions` with the vault as signer: vault transaction create, proposal create + approve,
 * execute. Returns the execute transaction signature (the one that actually moves state).
 */
export async function executeAsVault(
  rpc: SolanaRpc,
  rpcUrl: string,
  vault: SquadsVault,
  admin: KeyPairSigner,
  instructions: readonly Instruction[],
): Promise<{ executeSignature: string; signatures: string[]; transactionIndex: bigint }> {
  const connection = new Connection(rpcUrl, 'confirmed')
  const multisigPda = new PublicKey(vault.multisig)
  const adminKey = new PublicKey(admin.address)
  const ms = await squads.accounts.Multisig.fromAccountAddress(connection, multisigPda)
  const transactionIndex = BigInt(ms.transactionIndex.toString()) + 1n
  const { value: latest } = await rpc.getLatestBlockhash().send()
  const message = new TransactionMessage({
    payerKey: new PublicKey(vault.vault),
    recentBlockhash: latest.blockhash,
    instructions: instructions.map(kitToWeb3Instruction),
  })
  const create = squads.instructions.vaultTransactionCreate({
    multisigPda,
    transactionIndex,
    creator: adminKey,
    vaultIndex: vault.vaultIndex,
    ephemeralSigners: 0,
    transactionMessage: message,
  })
  const s1 = await sendAndConfirm(rpc, {
    feePayer: admin,
    instructions: [web3ToKitInstruction(create, [admin])],
  })
  const propose = squads.instructions.proposalCreate({ multisigPda, creator: adminKey, transactionIndex })
  const approve = squads.instructions.proposalApprove({ multisigPda, transactionIndex, member: adminKey })
  const s2 = await sendAndConfirm(rpc, {
    feePayer: admin,
    instructions: [web3ToKitInstruction(propose, [admin]), web3ToKitInstruction(approve, [admin])],
  })
  const { instruction: execute } = await squads.instructions.vaultTransactionExecute({
    connection,
    multisigPda,
    transactionIndex,
    member: adminKey,
  })
  const s3 = await sendAndConfirm(rpc, {
    feePayer: admin,
    instructions: [web3ToKitInstruction(execute, [admin])],
  })
  return { executeSignature: s3, signatures: [s1, s2, s3], transactionIndex }
}
