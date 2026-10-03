import {
  type Address,
  appendTransactionMessageInstructions,
  type Base64EncodedWireTransaction,
  type Commitment,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  pipe,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from '@solana/kit'

export type SolanaRpc = Rpc<SolanaRpcApi>

export function createRpc(url: string): SolanaRpc {
  return createSolanaRpc(url)
}

export interface SendOptions {
  readonly feePayer: TransactionSigner
  readonly instructions: readonly Instruction[]
  readonly commitment?: Commitment
  readonly timeoutMs?: number
  readonly skipPreflight?: boolean
}

export class TransactionFailedError extends Error {
  constructor(
    message: string,
    readonly logs: readonly string[] = [],
    readonly signature?: string,
    override readonly cause?: unknown,
  ) {
    super(logs.length ? `${message}\n  logs:\n    ${logs.join('\n    ')}` : message)
    this.name = 'TransactionFailedError'
  }
}

/** Builds a v0 transaction, signs it with every signer referenced by the instructions, returns wire bytes. */
export async function buildSignedTransaction(
  rpc: SolanaRpc,
  feePayer: TransactionSigner,
  instructions: readonly Instruction[],
): Promise<{ wire: Base64EncodedWireTransaction; signature: Signature; lastValidBlockHeight: bigint }> {
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const signed = await signTransactionMessageWithSigners(message)
  return {
    wire: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }
}

/** Sends a transaction and polls until it reaches `commitment` (default `confirmed`). */
export async function sendAndConfirm(rpc: SolanaRpc, options: SendOptions): Promise<Signature> {
  const commitment = options.commitment ?? 'confirmed'
  const { wire, signature } = await buildSignedTransaction(rpc, options.feePayer, options.instructions)
  try {
    await rpc
      .sendTransaction(wire, {
        encoding: 'base64',
        preflightCommitment: 'confirmed',
        skipPreflight: options.skipPreflight ?? false,
      })
      .send()
  } catch (err) {
    throw new TransactionFailedError(
      `sendTransaction failed: ${describeError(err)}`,
      extractLogs(err),
      signature,
      err,
    )
  }
  await waitForSignature(rpc, signature, commitment, options.timeoutMs ?? 60_000)
  return signature
}

export interface SimulationResult {
  readonly err: unknown
  readonly logs: readonly string[]
  readonly unitsConsumed: bigint | undefined
  /** Post-simulation account states for the requested addresses, base64 data (null = account absent). */
  readonly accounts: readonly ({ lamports: bigint; owner: string; data: readonly [string, string] } | null)[]
}

/** Signs and simulates without sending. Pass `accounts` to receive their post-simulation state. */
export async function simulate(
  rpc: SolanaRpc,
  feePayer: TransactionSigner,
  instructions: readonly Instruction[],
  accounts: readonly Address[] = [],
): Promise<SimulationResult> {
  const { wire } = await buildSignedTransaction(rpc, feePayer, instructions)
  const base = { encoding: 'base64', commitment: 'confirmed', sigVerify: true } as const
  const res = await (accounts.length
    ? rpc
        .simulateTransaction(wire, { ...base, accounts: { encoding: 'base64', addresses: [...accounts] } })
        .send()
    : rpc.simulateTransaction(wire, base).send())
  const value = res.value as unknown as {
    err: unknown
    logs: string[] | null
    unitsConsumed?: bigint
    accounts?: ({ lamports: bigint; owner: string; data: [string, string] } | null)[] | null
  }
  return {
    err: value.err,
    logs: value.logs ?? [],
    unitsConsumed: value.unitsConsumed,
    accounts: value.accounts ?? [],
  }
}

/** Extracts `Custom(n)` from an `{ InstructionError: [index, { Custom: n }] }` transaction error. */
export function customErrorCode(err: unknown): { index: number; code: number } | null {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError
  if (!ie) return null
  const custom = (ie[1] as { Custom?: number | bigint } | null)?.Custom
  return custom === undefined ? null : { index: Number(ie[0]), code: Number(custom) }
}

export async function waitForSignature(
  rpc: SolanaRpc,
  signature: Signature,
  commitment: Commitment = 'confirmed',
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const rank = { processed: 0, confirmed: 1, finalized: 2 } as const
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send()
    const status = value[0]
    if (status) {
      if (status.err) {
        const tx = await fetchLogs(rpc, signature)
        throw new TransactionFailedError(
          `transaction ${signature} failed: ${JSON.stringify(status.err, bigintReplacer)}`,
          tx,
          signature,
        )
      }
      if (status.confirmationStatus && rank[status.confirmationStatus] >= rank[commitment]) return
    }
    await sleep(400)
  }
  throw new TransactionFailedError(`timed out waiting for ${signature} to reach ${commitment}`, [], signature)
}

async function fetchLogs(rpc: SolanaRpc, signature: Signature): Promise<string[]> {
  try {
    const tx = await rpc
      .getTransaction(signature, {
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      })
      .send()
    return [...(tx?.meta?.logMessages ?? [])]
  } catch {
    return []
  }
}

function extractLogs(err: unknown): string[] {
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    const ctx = (cur as { context?: { logs?: unknown } }).context
    if (ctx && Array.isArray(ctx.logs)) return ctx.logs as string[]
    cur = (cur as { cause?: unknown }).cause
  }
  return []
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message
  }
  return String(err)
}

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
