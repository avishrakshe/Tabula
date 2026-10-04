import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // the dashboard recomputes ledger Merkle roots in the browser with the same code the gateway uses
  transpilePackages: ['@tabula/ledger'],
}

export default nextConfig
