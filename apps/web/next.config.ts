import type { NextConfig } from 'next'

// Everything the site loads is same-origin (fonts are self-hosted by next/font). connect-src also allows a
// gateway on localhost (the dashboard's "Connect live") and Supabase (live mode, once deployed).
const csp = (frameAncestors: string) =>
  [
    "default-src 'self'",
    // Next's App Router streams its payload in inline scripts; static pages can't carry nonces
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' http://127.0.0.1:* http://localhost:* https://*.supabase.co wss://*.supabase.co",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ')

const common = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // the dashboard recomputes ledger Merkle roots in the browser with the same code the gateway uses
  transpilePackages: ['@tabula/ledger'],
  // PGlite (the local ledger, `next start` rehearsals) loads its WebAssembly itself; bundled, it fails with
  // "instantiateWasm is not a function". Deployed, the ledger is Postgres and PGlite is never loaded.
  serverExternalPackages: ['@electric-sql/pglite'],
  async headers() {
    // dev needs eval for React Refresh, so the CSP applies to production builds only
    if (process.env.NODE_ENV !== 'production') return []
    return [
      { source: '/:path*', headers: [...common, { key: 'Content-Security-Policy', value: csp("'none'") }] },
      // the hero alone may be framed (Framer embed); a later match overrides the header above
      { source: '/hero-embed', headers: [{ key: 'Content-Security-Policy', value: csp('*') }] },
    ]
  },
}

export default nextConfig
