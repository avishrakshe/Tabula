# Vendored generated clients

`payment-channels/` and `safe-codecs.ts` are copied verbatim from the Codama-generated
TypeScript client in
[`solana-foundation/payment-channels`](https://github.com/solana-foundation/payment-channels)
at commit `3ffa4d6728ad88e4a9667a76ad9ccd68a302c696` (2026-08-07), path `clients/typescript/src/`.

They are vendored because the client is not published to npm (`@payment-channels/client`
is a private workspace package upstream). License: MIT (Solana Foundation).

One local patch: `programs/paymentChannels.ts` returns `ExtendedClient<T, {...}>` from
`paymentChannelsProgram()` instead of `Omit<T, ...> & {...}`, so it typechecks against
`@solana/kit` 6.10. This matches the newer Codama output pay-kit vendors
(`typescript/packages/mpp/src/generated/payment-channels/programs/paymentChannels.ts`).
Tabula does not use the kit plugin; the patch only keeps `tsc` green.

Otherwise do not edit by hand. To refresh, copy the same directory from a newer upstream commit and
update the hash above and in `docs/FACTS.md`.
