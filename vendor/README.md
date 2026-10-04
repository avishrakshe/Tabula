# Vendored packages

## `solana-mpp-0.11.0-tabula.1.tgz`

`@solana/mpp` 0.11.0, the Solana MPP payment method (session server, session client, payment-channel open
builder), plus one Tabula patch (below). The base is built from
[`solana-foundation/pay-kit`](https://github.com/solana-foundation/pay-kit) at commit
`262c6b9a9f8b9d7b339e1ea83fe1b5a852f90ff5` (2026-10-02), `typescript/packages/mpp`, with
`pnpm install --frozen-lockfile && pnpm build && pnpm pack` (that tarball's SHA-256 was
`9122DAD8F58F3C4C6E363D81294551F17102B7C86BFD50C9B5CB271ACF484188`).

Why vendored: npm's latest `@solana/mpp` is 0.7.0 (2026-07-13). The published `@solana/pay-kit` 0.13.0
embeds this same 0.11.0 code in its bundle but does not export the session server/client entry points.
pay-kit vendors its own x402 dependencies the same way (`typescript/.x402-vendor/`).

### Patch `tabula.1`: devnet treasury owner for `distribute`

`dist/server/session/on-chain.js` built the `distribute` instruction with the mainnet program build's treasury
owner (`Cs2zdfUN…EqP`) on every network. The devnet build of the payment-channels program bakes in
`4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap` (see `docs/FACTS.md`), so a vendor's cooperative
settle-and-distribute failed on devnet with `TREASURY_ACCOUNT_MISMATCH`. The patch:

- `deriveTreasuryAddress(network)` returns the devnet owner when `network === 'devnet'`, and the mainnet one
  otherwise;
- `buildDistributeInstruction` takes an optional `network` (also added to `DistributeBuildArgs` in the `.d.ts`);
- `submitSettleAndDistribute` passes its `network` through.

The session server already passes `network` to `submitSettleAndDistribute`. Nothing else changed.

SHA-256: `837D783C56E91E47F0F460C63366517B0A4D52AE8D9237CA3A46BC89318472CF`. License: MIT (Solana Foundation).
