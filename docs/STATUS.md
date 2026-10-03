# STATUS

_Last updated 2026-10-04._

## Milestone 1 — Spike and facts ✅

**Done when:** `FACTS.md` filled in; a script opens a channel, signs 10 vouchers and settles on the sandbox
or devnet.

### What works (run, not assumed)

- `pnpm spike` on the Solana Payment Sandbox (`https://402.surfnet.dev:8899`):
  - funds ephemeral keys with surfnet cheatcodes;
  - opens a channel with `payer` = agent wallet and `authorized_signer` = a separate Tabula key;
  - signs and locally verifies 10 cumulative vouchers;
  - simulates the attacks: a payer-signed voucher fails with `VoucherSignerMismatch`, an over-deposit voucher
    fails with `VoucherOverDeposit`, and a replayed older voucher fails with `VoucherWatermarkNotMonotonic`;
  - permissionless `settle`, then payee `settleAndSeal` with the final voucher, then `distribute`
    (payee +$0.25, payer refunded $0.75, escrow closed).
- `packages/solana`: typed wrappers for open / settle / settleAndSeal / requestClose / seal / topUp /
  withdrawPayer / distribute, voucher encode/sign/verify, the Ed25519 precompile builder, send/confirm and
  simulate helpers, sandbox cheatcodes, and the keypair store (gitignored `keys/`).
- `docs/FACTS.md`: program IDs, the sandbox, voucher authority, treasury owners per cluster, SDK versions,
  the Subscriptions/Allowances program, Squads, and pay CLI backends.

### What is mocked

- Nothing in the spike is mocked. The sandbox state is a mainnet clone with cheatcode-funded balances (no
  real funds).

### What is next (Milestone 2, Oct 5–6)

- `packages/policy`: a pure `evaluate()` covering allowlist, max unit price, velocity, task budget, daily
  budget, anomaly and kill switch, with fast-check invariants.
- `packages/ledger`: Drizzle schema (SQLite), idempotent voucher rows, canonical serialization, Merkle tree.
- `apps/vendor-mock`: a pay-kit MPP-session server (two vendors, seeded errors and empties).
- `apps/gateway`: Fastify, per-agent API keys, a policy-gated voucher signer, and 402 challenge verification
  plus simulation (`PAYEE_MISMATCH`, `SIMULATION_MISMATCH`).
- Decide the MPP client path: vendor a build of `@solana/mpp@0.11` vs speak the session wire protocol
  directly (npm only has 0.7.0).
