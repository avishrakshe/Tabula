import {
  type Address,
  appendTransactionMessageInstructions,
  type Base64EncodedWireTransaction,
  type Commitment,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
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

const isRateLimited = (err: unknown): boolean => {
  const status = (err as { context?: { statusCode?: number }; statusCode?: number })?.context?.statusCode
  return status === 429 || /\b429\b|Too Many Requests/i.test(String((err as Error)?.message ?? ''))
}

/**
 * An RPC client whose transport retries HTTP 429 (rate limited) with exponential backoff and jitter.
 * Public devnet endpoints throttle hard, and serverless functions share egress IPs; a burst that hits
 * the limit should slow down, not fail a payment.
 */
export function createRpc(url: string, attempts = 7): SolanaRpc {
  const transport = createDefaultRpcTransport({ url })
  const retrying = (async (config: Parameters<typeof transport>[0]) => {
    for (let i = 0; ; i++) {
      try {
        return await transport(config)
      } catch (err) {
        if (i >= attempts - 1 || !isRateLimited(err) || config.signal?.aborted) throw err
        await sleep(Math.min(6_000, 250 * 2 ** i) + Math.random() * 250)
      }
    }
  }) as typeof transport
  return createSolanaRpcFromTransport(retrying) as unknown as SolanaRpc
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

/**
 * One line for a log people read (the dashboard timeline): the program's own error when the logs carry
 * one, without the encoded payload @solana/kit appends to its errors in production builds.
 */
export function briefError(err: unknown): string {
  const logs = err instanceof TransactionFailedError ? err.logs : []
  const programError = logs.map((l) => /Program log: (?:Error: )?(.+)/.exec(l)?.[1]).find(Boolean)
  const head = (err instanceof Error ? err.message : String(err))
    .split('\n')[0]!
    .replace(/;? ?Decode this error by running `[^`]*`/g, '')
    .replace(/\s*\(Solana error #-?\d+\)/g, '')
    .trim()
  return programError ? `${head.split(':')[0]}: ${programError}` : head.slice(0, 240)
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message
  }
  return String(err)
}

const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111' as Address

/** The cluster's own unix time (Clock sysvar), which on surfnet/devnet can drift from wall clock. */
export async function clusterUnixTime(rpc: SolanaRpc): Promise<bigint> {
  const { value } = await rpc.getAccountInfo(CLOCK_SYSVAR, { encoding: 'base64' }).send()
  if (!value) throw new Error('Clock sysvar not found')
  const bytes = Buffer.from(value.data[0], 'base64')
  // Clock { slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64 }
  return bytes.readBigInt64LE(32)
}

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
