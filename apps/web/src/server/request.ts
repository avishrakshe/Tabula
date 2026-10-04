import { createHash } from 'node:crypto'
import { publicRpcUrl } from '@tabula/solana'

/** sha256 of the caller's IP with a server secret (raw IPs are never stored). */
export function requesterHash(req: Request): string {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || 'local'
  const salt = process.env.CRON_SECRET ?? process.env.TABULA_KEY_SEED ?? 'tabula'
  return createHash('sha256').update(`${ip}:${salt}`).digest('hex').slice(0, 32)
}

/** Where the hosted demo vendors answer: the configured site, else this request's own origin. */
export function vendorBase(req: Request): string {
  if (process.env.TABULA_VENDOR_BASE) return process.env.TABULA_VENDOR_BASE.replace(/\/$/, '')
  const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '')
  return `${site ?? new URL(req.url).origin}/api/vendors`
}

/**
 * An error message fit for a public response: a failed RPC call can echo its URL, and a paid provider's
 * URL carries the API key.
 */
export function scrub(message: string): string {
  const url = process.env.TABULA_RPC_URL
  const out = url ? message.split(url).join(publicRpcUrl(url)) : message
  return out.replace(/(api[-_]?key=)[^&\s"']+/gi, '$1…').slice(0, 300)
}

export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
