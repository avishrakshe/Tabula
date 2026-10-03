# Tabula

**Every agent payment, accounted for.**

Tabula is spend control and treasury for AI agents that pay through
[Solana payment channels](https://github.com/solana-foundation/payment-channels). A channel lets an agent
escrow a ceiling onchain once, then pay a vendor with many off-chain cumulative vouchers and settle once.
That makes agent payments cheap, but it moves real spending off-chain, where wallets and multisigs cannot
see it. Tabula holds the voucher-signing key for your agents and checks every voucher against company policy
before it signs. It can cut off a runaway agent mid-stream, reclaim idle escrow, and record every voucher in a
ledger that is anchored onchain and reconciled against settlement.

> Hackathon build for Colosseum's Crypto World's Fair (Solana track). Work in progress — see
> [`docs/STATUS.md`](docs/STATUS.md) for what works today and what is mocked.

## Status

- Milestone 1 (spike + facts) is done. `pnpm spike` opens a real payment channel on the Solana Payment
  Sandbox, signs 10 vouchers with a Tabula-held key, and shows the program rejecting agent-signed and
  over-deposit vouchers. It then settles, seals and distributes. Verified facts are in
  [`docs/FACTS.md`](docs/FACTS.md).

## Quickstart (so far)

```sh
pnpm i
pnpm spike          # runs against https://402.surfnet.dev:8899 (no real funds)
```

Requires Node ≥ 22.13 and pnpm 11.

## Repo layout

```
packages/solana   payment-channels wrappers (vendored Codama client), vouchers, sandbox cheatcodes, keys
scripts/          spike-channel.ts (M1); setup and demo scripts land in later milestones
docs/             FACTS.md (verified ecosystem facts), STATUS.md
```

## License

MIT
