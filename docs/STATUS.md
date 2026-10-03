# STATUS

_Last updated 2026-10-04._

| Milestone | State | Tag |
|---|---|---|
| M1 Spike and facts | ✅ done | `m1-spike` |
| M2 Gateway, policy, verification | ✅ done (site skeleton still open) | `m2-gateway` |
| M3 Kill and float ‖ 3D hero | next | |
| M4 Ledger, receipts, reconciliation, scorecards | partly done (pure logic shipped in M2) | |
| M5 Dashboard | not started | |

## What works (run, not assumed)

### Onchain (Solana Payment Sandbox, `https://402.surfnet.dev:8899`)

- `pnpm spike`: raw program flow. Open with a Tabula-held `authorized_signer`, then 10 vouchers. The program
  rejects payer-signed (237), over-deposit (235) and replayed (234) vouchers. Then settle, settle_and_seal
  and distribute.
- `pnpm tsx scripts/spike-mpp.ts`: the MPP session wire protocol against the stock `@solana/mpp` server.

### `packages/policy`: pure engine, 63 tests, 100% branch coverage enforced

- Rules: vendor allow/deny, max unit price, channel deposit and onchain-ceiling caps, per-task and daily
  budgets, multi-window velocity, z-score anomaly, and global and agent kill.
- Plain-language reasons, e.g. "Stopped paying rogue-01: spent $0.021 in 60s (limit $0.02)".
- fast-check invariants:
  - no signed cumulative above the deposit or the ceiling;
  - nothing signed after a kill;
  - ledger total = sum of signed deltas;
  - limits are never exceeded;
  - every block is the first violating voucher.

### `packages/ledger`: Drizzle on `node:sqlite` (no native deps), 21 tests

- Schema for agents, vendors, policies, tasks, channels, vouchers (with idempotency keys), challenge checks,
  batches and events.
- Canonical JSON and a domain-tagged sorted-pair SHA-256 Merkle tree with proofs (browser-safe).
- The batch memo format, reconciliation states, and vendor scorecards with cheaper-option hints.

### `apps/vendor-mock`

- `inference-a`, `inference-b` and a malicious `mirror`, all on the unmodified `@solana/mpp` session server
  with sponsored fees.
- Seeded errors, empties and timeouts, plus an admin "down" switch.

### `apps/gateway`: Fastify, 23 unit tests, plus 7 sandbox integration tests (`pnpm --filter @tabula/gateway test:integration`)

- Agents authenticate with per-agent API keys and never hold keys. Each agent has a Tabula-held payer
  wallet and a voucher key.
- Session open, before anything is signed:
  - the 402 challenge is checked against the registry (payee, mint, program, network, price, splits, signer
    mode, fee sponsorship);
  - the open transaction is simulated, and only the deposit may leave the agent wallet.
- A rejected request is recorded as `PAYEE_MISMATCH`, `SIMULATION_MISMATCH` and so on, with a reason in plain
  language.
- Vouchers: policy approval, then a single-use approval unlocks the guarded signer, which re-checks kill
  state, monotonicity and deposit. The row is written to the ledger before the voucher is sent. The vendor
  call's outcome (ok, error, empty, timeout) and latency are recorded.
- Kill path: the signer refuses first, the status is persisted, then the channels close. Close is
  cooperative (replaying the last signed voucher, so the agent never pays an extra unit) or a forced close
  onchain. The refund goes back to the agent wallet, and every step is in the audit log with explorer links.
- Integration test (live sandbox):
  - 500 vouchers on one channel, then voucher #501 refused with `CHANNEL_DEPOSIT`;
  - agent retries answered from the ledger;
  - the swapped payee blocked before signing;
  - a hostile challenge caught by simulation;
  - `rogue-01` blocked at exactly voucher #14 by velocity: never signed, agent killed, channel settled at the
    last signed voucher and refunded;
  - cooperative close settles exactly what was signed and reconciles `MATCHED`.
- Restart recovery: open sessions are rebuilt from the ledger, and unfinished vendor calls are marked as
  timeouts.

## What is mocked or simplified

- **Funding.** Agent wallets are topped up with surfnet cheatcodes (`FaucetTreasury`). The onchain ceiling
  (Squads vault plus Subscriptions-program allowance) is M3.
- **Vendors are local mocks**, but they run the real `@solana/mpp` session server against the real
  payment-channels program on the sandbox.
- **`@solana/mpp` 0.11.0 is vendored** (built from pay-kit source; npm only has 0.7.0).
- **The forced close path is implemented but not yet integration-tested** (the vendor grace period is 60s;
  that test lands in M3).

## Next

1. **M3:**
   - the onchain-ceiling treasury: Squads vault, a Subscriptions-program delegation per agent, and a
     just-in-time pull before open;
   - sweep refunds back to the vault;
   - float sizing with the p95 of past sessions, top-ups within the ceiling, and the idle sweeper;
   - a forced-close integration test (vendor down).
2. **M4:** the anchoring batcher (Memo), `scripts/verify-batch.ts`, and reconcile, export and scorecard endpoints.
3. **Site:** the Next.js app skeleton (marketing plus dashboard shell, design tokens) and the 3D hero.
