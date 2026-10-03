# Vendored packages

## `solana-mpp-0.11.0.tgz`

`@solana/mpp` 0.11.0, the Solana MPP payment method (session server, session client, payment-channel open
builder). It is built from
[`solana-foundation/pay-kit`](https://github.com/solana-foundation/pay-kit) at commit
`262c6b9a9f8b9d7b339e1ea83fe1b5a852f90ff5` (2026-10-02), `typescript/packages/mpp`, with
`pnpm install --frozen-lockfile && pnpm build && pnpm pack`.

Why vendored: npm's latest `@solana/mpp` is 0.7.0 (2026-07-13). The published `@solana/pay-kit` 0.13.0
embeds this same 0.11.0 code in its bundle but does not export the session server/client entry points.
pay-kit vendors its own x402 dependencies the same way (`typescript/.x402-vendor/`).

SHA-256: `9122DAD8F58F3C4C6E363D81294551F17102B7C86BFD50C9B5CB271ACF484188`. License: MIT (Solana Foundation).
