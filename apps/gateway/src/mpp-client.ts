/**
 * The vendor side of a session, spoken in the MPP wire format (`WWW-Authenticate: Payment` challenges,
 * `Authorization: Payment` credentials, `Payment-Receipt` receipts) via @solana/mpp's client helpers,
 * so Tabula pays any vendor running the stock pay-kit / @solana/mpp session server unchanged.
 */
import {
  type SessionAction,
  type SessionChallenge,
  selectSolanaSessionChallengeFromResponse,
  serializeSessionCredential,
} from '@solana/mpp/client'
import { TimeoutError, withTimeout } from './util'

export type Outcome = 'ok' | 'error' | 'empty' | 'timeout'

export interface PaymentReceipt {
  readonly acceptedCumulative?: string
  readonly spent?: string
  readonly refunded?: string
  readonly txHash?: string
  readonly status?: string
  readonly reference?: string
}

export function parseReceipt(res: Response): PaymentReceipt | null {
  const h = res.headers.get('payment-receipt')
  if (!h) return null
  try {
    return JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as PaymentReceipt
  } catch {
    return null
  }
}

export class VendorUnreachableError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'VendorUnreachableError'
  }
}

/** Requests the resource without paying and returns the session challenge from the 402. */
export async function fetchChallenge(endpoint: string, timeoutMs: number): Promise<SessionChallenge | null> {
  let res: Response
  try {
    res = await withTimeout(timeoutMs, (signal) => fetch(endpoint, { signal }))
  } catch (err) {
    throw new VendorUnreachableError(`could not reach ${endpoint}: ${(err as Error).message}`, err)
  }
  if (res.status !== 402) {
    await res.body?.cancel()
    return null
  }
  return selectSolanaSessionChallengeFromResponse(res) ?? null
}

export function credentialFor(challenge: SessionChallenge, payload: SessionAction): string {
  return serializeSessionCredential({ challenge, payload, source: 'tabula-gateway' })
}

/** True when the challenge expires within `marginMs` (mppx challenges default to 5 minutes). */
export function challengeExpiring(challenge: SessionChallenge, marginMs = 30_000, now = Date.now()): boolean {
  const expires = (challenge as { expires?: string }).expires
  if (!expires) return false
  const t = Date.parse(expires)
  return Number.isNaN(t) ? false : t - now < marginMs
}

export interface CallResult {
  readonly httpStatus: number | null
  readonly outcome: Outcome
  readonly body: unknown
  readonly latencyMs: number
  readonly receipt: PaymentReceipt | null
  /** The vendor refused the credential (e.g. voucher not accepted). */
  readonly rejected: boolean
}

/** Sends one authorized request and classifies the response for waste accounting. */
export async function authorizedCall(
  endpoint: string,
  authorization: string,
  timeoutMs: number,
  query: Record<string, string> = {},
): Promise<CallResult> {
  const url = new URL(endpoint)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const started = performance.now()
  try {
    const { status, text, receipt } = await withTimeout(timeoutMs, async (signal) => {
      const res = await fetch(url, { headers: { authorization }, signal })
      return { status: res.status, text: await res.text(), receipt: parseReceipt(res) }
    })
    const latencyMs = Math.round(performance.now() - started)
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      // keep raw text
    }
    if (status === 402)
      return { httpStatus: status, outcome: 'error', body, latencyMs, receipt, rejected: true }
    if (status >= 400)
      return { httpStatus: status, outcome: 'error', body, latencyMs, receipt, rejected: false }
    const completion = (body as { completion?: unknown } | null)?.completion
    const empty = text.trim() === '' || body === null || completion === ''
    return { httpStatus: status, outcome: empty ? 'empty' : 'ok', body, latencyMs, receipt, rejected: false }
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started)
    if (err instanceof TimeoutError) {
      return { httpStatus: null, outcome: 'timeout', body: null, latencyMs, receipt: null, rejected: false }
    }
    throw new VendorUnreachableError(`call to ${url.origin} failed: ${(err as Error).message}`, err)
  }
}
