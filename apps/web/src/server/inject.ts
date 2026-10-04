import { after } from 'next/server'
import { gateway } from './gateway'

/**
 * Dashboard reads that anyone may make on the hosted demo (read-only, and nothing secret: API-key hashes
 * are stripped by the gateway). The server adds the admin token for these; every other call (kill, revive,
 * policy edits, sweeps, anchoring) still needs a caller who holds it, and agents use their own API keys.
 */
const PUBLIC_READS: readonly RegExp[] = [
  /^GET \/health$/,
  /^GET \/v1\/(overview|agents|vendors|float|channels|challenges|events|policies|reconcile|scores|batches|vouchers|export\.csv)$/,
  /^GET \/v1\/batches\/\d+$/,
  /^POST \/v1\/batches\/\d+\/verify$/, // reads the chain, writes nothing
]

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length'])

/** Serves one request with the gateway's Fastify app (same routes, auth and validation as `pnpm demo`). */
export async function injectGateway(req: Request, path: string): Promise<Response> {
  const { gw, app } = await gateway()
  const url = new URL(req.url)
  const headers: Record<string, string> = {}
  req.headers.forEach((v, k) => {
    headers[k] = v
  })
  if (!headers.authorization && PUBLIC_READS.some((r) => r.test(`${req.method} ${path}`)))
    headers.authorization = `Bearer ${gw.config.adminToken}`
  const payload = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text()
  const res = await app.inject({
    method: req.method as 'GET',
    url: path + url.search,
    headers,
    ...(payload ? { payload } : {}),
  })
  // a voucher that tripped a kill keeps closing channels after the response; finish it before freezing
  after(() => gw.sessions.drain())
  const out = new Headers()
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k)) continue
    out.set(k, Array.isArray(v) ? v.join(', ') : String(v))
  }
  out.set('cache-control', 'no-store')
  return new Response(res.statusCode === 204 ? null : new Uint8Array(res.rawPayload), {
    status: res.statusCode,
    headers: out,
  })
}
