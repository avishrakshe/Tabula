# STATUS

_Last updated 2026-10-04._

| Milestone | State | Tag |
|---|---|---|
| M1 Spike and facts | ✅ done | `m1-spike` |
| M2 Gateway, policy, verification | ✅ done (site skeleton still open) | `m2-gateway` |
| M3 Kill and float ‖ 3D hero | ✅ kill/float done (3D hero not started) | `m3-kill-float` |
| M4 Ledger, receipts, reconciliation, scorecards | ✅ done (plus `pnpm demo`) | `m4-ledger` |
| M5 Dashboard | ✅ checked in a browser, live and replay, including every action | |

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

### M3: onchain ceiling, kill path and float manager (sandbox integration test `kill-float.test.ts`, 5 tests)

- `pnpm setup` (idempotent):
  - creates a Squads v4 vault holding $1,000 (sandbox USDC) and the vault's SubscriptionAuthority;
  - grants a $5/day recurring allowance to each demo agent wallet (Subscriptions program, via vault
    transactions);
  - writes the vendor registry, policies, and agent API keys (to the gitignored `keys/agents.json`).
- `CeilingTreasury`: each deposit is pulled just in time from the agent's allowance, so the onchain ceiling
  holds even if every off-chain check failed. An allowance that can't fund a deposit returns
  `ONCHAIN_CEILING`.
- Float sizing = min(what's available under the allowance, per-task budget, p95 of past sessions × 1.2).
  The reasoning is logged as a `float_sized` event.
- Kill path, tested end to end with the real vault:
  - velocity trip → cooperative close at the last signed voucher → refund → swept back to the vault;
  - with the vendor down → forced close (request_close, 60s grace period on the cluster clock, seal,
    distribute) → full refund → swept.
- Idle sweep: `POST /v1/float/sweep` closes idle channels and returns idle wallet float to the vault.
  `GET /v1/float` shows the escrow tied up per channel and per vendor.
- The test ends with exact vault accounting: vault after = vault before − Σ settled onchain.

### M4: onchain receipts, reconciliation, scorecards (sandbox integration test `receipts.test.ts`, 7 tests)

- The gateway anchors the ledger every 40 vouchers (and at shutdown). Each batch is the next contiguous run of
  finalized rows; its root is a sorted-pair SHA-256 Merkle root over canonical rows, written with the Memo
  program as `tabula:v1 batch=… root=…`.
- `scripts/verify-batch.ts` and `POST /v1/batches/:id/verify` recompute each root from the ledger and compare
  it with the memo read back from the chain. `GET /v1/batches/:id` returns canonical rows so the dashboard
  can recompute the root in the browser. An edited row is detected.
- `GET /v1/reconcile`: one row per closed channel, ledger signed vs. the onchain `settled` watermark (re-read
  while the account exists).
- `GET /v1/scores`: waste %, cost per completed task, p95 latency, and cheaper-option hints.
- `GET /v1/export.csv`: every voucher, with its batch transaction link.

### `pnpm demo` (after `pnpm setup`): verified run on the sandbox, 2026-10-04

- Three agents open channels funded from the Squads vault allowances.
- coder-01's poisoned "faster mirror" is blocked as `PAYEE_MISMATCH` before anything is signed, and it falls
  back to the registered vendor.
- rogue-01 is prompt-injected at 0:45. The velocity rule blocks a specific voucher at 0:59 ("Stopped paying
  rogue-01: spent $0.06125 in 60s (limit $0.06)"). The channel closes cooperatively at $0.06 settled, and the
  $0.565 refund is swept back to the vault.
- The idle sweep at 2:00 reclaims coder-01's abandoned channel ($0.616).
- Close-out:
  - 7 batches anchored, 7/7 verified (`verify-batch` too);
  - 4/4 channels `MATCHED`;
  - scorecards: inference-b wasted 9.1% of paid calls, and inference-a does the same task 27% cheaper;
  - vault $997.7315 → $997.47375, down exactly what vendors settled onchain ($0.25775); the demo prints
    this check, and first sweeps any float an interrupted earlier run left in agent wallets;
  - 244 vouchers signed, 1 blocked.
- Outputs: `data/demo-ledger.csv`, `data/demo-events.jsonl` (replay log), `data/demo.sqlite`, and the
  committed replay fixture `apps/web/public/replay/demo.json` (public data only).

### M5: dashboard (`apps/web`, `/app`)

- **Pages:**
  - **Overview:** KPIs, cumulative spend by agent, live voucher feed, onchain activity.
  - **Agents:** budget meters, onchain allowance, stop/resume. The agent detail page charts trailing-60s spend
    against the velocity limit and has tasks, a versioned policy editor and a timeline.
  - **Channels & float:** escrow by vendor, plus a "Sweep idle" action.
  - **Ledger:** filterable vouchers. A batch's "Verify" recomputes the Merkle root in the browser and compares
    it with the onchain memo.
  - **Reconciliation:** badges and CSV export.
  - **Vendors:** scorecards, cheaper-option hints, blocked payment requests, registry.
  - **Policies.**
- **Data:** live mode uses the gateway API and SSE stream with an admin token (the demo login). Without a
  gateway it replays `public/replay/demo.json`.
- **Design:** Paymark-style tokens; `sever` and `matched` are reserved and always paired with an icon and a
  word. Light by default, with a dark mode. The chart palette passed the dataviz validator on `#fff` and
  `#141414`, and every chart has a table view.
- **Verified (2026-10-04, `next build` + `next start`, Chrome):**
  - replay mode, with no gateway running: every page at mid-run and at the end. The in-browser batch
    Verify recomputes the Merkle root (12 ms) and it equals the onchain memo root;
  - live mode against `pnpm demo --hold`: SSE feed, chart, kill timeline, Policies, and dark mode;
  - fixes from that pass: the data layer was never committed (an unanchored `data/` gitignore rule), the
    Active and Stopped pills looked alike, the kill message repeated itself, plus small copy and layout fixes.
- **Actions, clicked through against a live gateway:** Resume, Stop → Confirm stop, Save policy (invalid
  JSON refused with a red error; a valid edit saved as the next version of the selected scope), and Sweep
  idle. Saving a policy had been broken: `@fastify/cors` allows only GET/HEAD/POST by default, so the
  browser blocked the PUT. A unit test now checks the preflight.
- **Browser automation note:** an occluded Chrome window reports `visibilityState: hidden`, and the first
  inputs of a batch can be lost. Do one action at a time and read the state back.
- **Memory:** on this machine (~1 GB free with Chrome open), use `next build` + `next start`, not
  `next dev`, and run one heavy process at a time.

## What is mocked or simplified

- **Funding.** With `pnpm setup` the money comes from a real Squads vault through real onchain allowances
  (sandbox balances). Without setup, tests fall back to `FaucetTreasury` (cheatcode top-ups).
- **The shared sandbox's clock drifts** (other users time-travel it). All onchain waits poll the cluster
  clock. There is no local surfpool on Windows (the npm package ships only macOS and Linux binaries).
- **Vendors are local mocks**, but they run the real `@solana/mpp` session server against the real
  payment-channels program on the sandbox.
- **`@solana/mpp` 0.11.0 is vendored** (built from pay-kit source; npm only has 0.7.0).
- **No automatic top-ups yet.** When a channel's escrow is used up, the voucher is refused with
  `CHANNEL_DEPOSIT` and the agent opens a new session.

## Next

1. **Site:** the marketing page and the 3D hero (`/`, `/hero-embed`), styled after studying the Paymark
   reference in the browser.
2. **M6/M7:** freeze, `docs/PITCH.md`, README, Vercel deploy, demo video.
