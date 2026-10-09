# Tabula

**Every agent payment, accounted for.**

AI agents can now pay per call. [Solana payment channels](https://solana.com/news/payment-channels-1-million-payments-per-second)
let an agent escrow a deposit once, then stream thousands of signed vouchers to a vendor off-chain, settling in a
single transaction. That makes per-call pricing work, and it moves real spending to where wallets, multisigs and
books can't see it. A prompt-injected agent can empty its escrow before anyone looks.

**Tabula is the buyer's side of that stream:**

- It holds your agents' signing keys, and checks every voucher against company policy before signing it.
- It refuses a vendor whose payment request names the wrong payee, and stops a runaway agent mid-stream.
- It sweeps idle escrow back to your treasury.
- It anchors a receipt for every voucher onchain and reconciles each channel against what settled.

> **Live:** <https://tabula-agents.vercel.app> (the landing page),
> <https://tabula-agents.vercel.app/app> (the dashboard, replaying a recorded run) and
> <https://tabula-agents.vercel.app/film> (what Tabula does, as an 81-second motion graphic).
>
> Built for Colosseum's Crypto World's Fair (Solana track). The hosted dashboard replays a run recorded on
> **Solana devnet** (test USDC) on 2026-10-04, with every transaction linked to the devnet explorer. Locally,
> `pnpm demo` runs the same story against the hosted **Solana Payment Sandbox** (a mainnet clone with test
> balances) by default. No real funds move anywhere.
> Progress and verified facts: [`docs/STATUS.md`](docs/STATUS.md), [`docs/FACTS.md`](docs/FACTS.md).
> The pitch: [`docs/PITCH.md`](docs/PITCH.md).

## What it does

| | |
|---|---|
| **Gate every voucher** | Per-task and daily budgets, unit-price caps, vendor allowlists, velocity windows, spend anomalies. Agents hold an API key, never a signing key; a guarded signer re-checks kill state, monotonicity and deposit before it signs. |
| **Block swapped payees** | Every 402 payment request is checked against a vendor registry (payee, mint, program, price, splits), and the open transaction is simulated so only the deposit can leave the wallet. A mismatch is refused before anything is signed (`PAYEE_MISMATCH`). |
| **Stop a runaway agent** | The voucher that would cross a limit is refused unsigned. Then the agent is stopped, its channels close at the last signed voucher (or are forced closed onchain if the vendor is down), and the refund is swept back to the vault. |
| **Treasury, not just guardrails** | A Squads v4 vault funds each agent wallet just in time through onchain allowances (the Subscriptions & Allowances program), so the ceiling holds even if every off-chain check failed. A float manager sizes deposits and sweeps idle channels. |
| **Prove every dollar** | Every 40 vouchers, a sorted-pair SHA-256 Merkle root of the ledger is anchored with the Memo program. The dashboard recomputes it in your browser. Each closed channel reconciles to `MATCHED` against onchain settlement, and every voucher exports to CSV. |
| **Vendor scorecards** | Waste % and cost per completed task, from your own paid calls, with a cheaper option when there is one. |

## Architecture

```mermaid
flowchart LR
  subgraph Agents
    A1[research-01]
    A2[coder-01]
    A3[rogue-01]
  end
  subgraph Tabula gateway
    API[Agent API<br/>per-agent API keys]
    CV[Challenge verifier<br/>registry + simulation]
    PE[Policy engine<br/>pure, property-tested]
    GS[Guarded signer<br/>Tabula-held keys]
    LG[(Ledger<br/>Postgres + Drizzle)]
    FM[Float manager<br/>sizing, idle sweep]
    AN[Anchorer<br/>Merkle roots]
  end
  subgraph Vendors
    V1[inference-a<br/>@solana/mpp session server]
    V2[inference-b]
  end
  subgraph Solana
    PC[Payment channels program]
    SQ[Squads v4 vault<br/>+ onchain allowances]
    MM[Memo program]
  end
  WEB[Dashboard<br/>Next.js, SSE]

  A1 & A2 & A3 -->|API key only| API
  API --> CV -->|402 challenge OK| PE --> GS
  GS -->|signed voucher| V1 & V2
  GS --> LG
  CV -->|open channel| PC
  FM -->|pull deposit just in time| SQ
  FM -->|close, refund, sweep| PC
  AN -->|batch root| MM
  LG --> AN
  LG -->|REST + SSE| WEB
```

**Packages:**

- `packages/policy`: the pure rule engine (no I/O). 63 tests, 100% branch coverage, and fast-check invariants:
  nothing is signed above the deposit or after a kill, and every block is the first violating voucher.
- `packages/ledger`: Drizzle schema on Postgres (Supabase when hosted, PGlite locally, so nothing to
  install), canonical rows, Merkle trees with proofs (browser-safe), reconciliation and scorecards.
- `packages/solana`: payment-channels client (vendored Codama build), voucher encoding, sandbox cheatcodes,
  keys.

**Apps:**

- `apps/gateway`: the Fastify gateway (sessions, custody, kill path, float manager, anchoring, reports, SSE).
- `apps/vendor-mock`: the vendors, running the unmodified `@solana/mpp` session server.
- `apps/agents`: the demo agents.
- `apps/web`: the landing page with the 3D hero and the waitlist (`/`), the dashboard (`/app`), the film
  (`/film`), and the embeddable hero (`/hero-embed`). For hosting, the same gateway and vendor code also
  runs as Next.js route handlers (`/api/v1/*`, `/api/vendors/*`, `/api/demo/*`, `/api/cron/*`) on one
  shared Postgres ledger.

## Quickstart

Requires Node ≥ 22.13 and pnpm 11. Runs against `https://402.surfnet.dev:8899` by default (no setup, no real
funds).

```sh
pnpm i
pnpm setup     # Squads vault with $1,000 sandbox USDC, $5/day allowance per demo agent, vendor registry, policies
pnpm demo      # the full story in ~3 minutes (see below); add --hold to keep the gateway up afterwards
```

Then watch it in the dashboard:

```sh
pnpm --filter @tabula/web build
pnpm --filter @tabula/web start   # http://localhost:3000/app
```

With `pnpm demo --hold` running, the dashboard connects live: the SSE feed, stop/resume, policy edits and idle
sweeps all work. Without a gateway it replays the recorded run in `apps/web/public/replay/demo.json`
(`/app?replay`, or `/app?replay&t=59` to open at 0:59).

**What `pnpm demo` does** (figures from the devnet run the hosted dashboard replays; a fresh run's figures
differ slightly):

1. **0:00:** three agents open channels, funded from the vault's allowances.
2. **0:25:** coder-01 follows a poisoned link to a "faster mirror". Its 402 names another payee, so it's blocked
   before signing (`PAYEE_MISMATCH`) and the agent falls back to the real vendor.
3. **0:45:** rogue-01 reads a prompt-injected ticket and calls as fast as it can. The velocity rule refuses its
   voucher #49, the one that would cross the limit ("spent $0.06125 in 60s, limit $0.06"). The agent is
   stopped, its channel closes at $0.06 settled, and $0.565 goes back to the vault.
4. **2:00:** the float manager closes coder-01's abandoned channel and reclaims $0.616.
5. **Close-out:**
   - 214 vouchers signed and 1 blocked. 6/6 ledger batches are verified against their onchain memos, and
     4/4 channels are `MATCHED`.
   - The scorecards show inference-b wasting 9.1% of paid calls and inference-a doing the same task 26% cheaper.
   - The vault ends down exactly what vendors settled ($0.22775), and the run exports a CSV.

**Tests:**

```sh
pnpm test                                            # 126 unit tests: policy, ledger, gateway, solana, vendor-mock
pnpm --filter @tabula/gateway test:integration      # 19 integration tests on the live sandbox
pnpm lint && pnpm typecheck
```

The sandbox integration tests cover:

- 500 vouchers on one channel, with #501 refused;
- the swapped payee, and a hostile challenge caught by simulation;
- the kill path, both cooperative and forced onchain;
- exact vault accounting;
- receipts, and detection of an edited ledger row.

## Deploy (Vercel)

The site and the dashboard's replay mode are static and need no gateway.

1. Import the GitHub repo in Vercel and set **Root Directory** to `apps/web`. The framework (Next.js) is
   detected, and the workspace installs from the repo root.
2. Add the environment variable `ENABLE_EXPERIMENTAL_COREPACK=1`, so Vercel uses the pinned
   `pnpm@11.25.0`.
3. Deploy. `pnpm build` copies detect-gpu's benchmark tables into `public/gpu` and runs `next build`.

A hosted dashboard replays the recorded run. To point it at a live gateway, set
`NEXT_PUBLIC_TABULA_GATEWAY_URL`, or use **Connect gateway** in the dashboard header.

**Hosted live mode (optional).** The route handlers run the gateway only when `DATABASE_URL` (the Supabase
transaction pooler) is set, together with the devnet settings (`TABULA_CLUSTER=devnet`, `TABULA_MINT`,
`TABULA_KEY_SEED`, `TABULA_RPC_URL`) and `CRON_SECRET`, after `pnpm setup` has written the devnet treasury
into that database. Until then every `/api/*` gateway route answers `503 the live ledger is offline` and the
dashboard replays the recorded run, so a visitor never sees a broken page.

**Waitlist.** The landing page's early-access form writes to the ledger's `waitlist` table (row level security
on, like every ledger table). It uses `DATABASE_URL`, else the `POSTGRES_URL` that Vercel's Supabase
integration sets; without either, the form says sign-ups aren't open yet. After pulling new migrations, apply
them with `pnpm tsx --env-file=.env.local scripts/migrate.ts` (it prefers `DIRECT_URL`, then
`POSTGRES_URL_NON_POOLING`). Sign-ups are rate-limited per network, and the answer never reveals whether an
email was already on the list.

**The film.** `/film` plays the motion graphic live in the browser (it's drawn in code from the recorded
run's numbers). To render it to MP4 (1920×1080, 30 fps), start the site and run `pnpm film:render`; it needs
ffmpeg and writes `apps/web/public/film/tabula-film.mp4`, which `/film` then offers as a download.

## What is real and what is mocked

- **Real:**
  - the payment-channels program and the Squads v4 and Subscriptions & Allowances programs (mainnet builds,
    cloned by the sandbox);
  - the `@solana/mpp` session protocol on both sides;
  - every transaction, voucher signature, Memo receipt and reconciliation read.
- **Simulated:**
  - **Funds:** the sandbox writes balances with cheatcodes, so there's no real USDC.
  - **Vendors:** local mock inference APIs with seeded errors, empty responses and timeouts. They run the stock
    session server against the real program.
  - **Agents:** scripted, and the prompt injection is simulated.
- **Not built yet:** automatic channel top-ups (an exhausted channel refuses with `CHANNEL_DEPOSIT` and the
  agent opens a new session), treasury yield, approval workflows, and an MCP server.

See [`docs/STATUS.md`](docs/STATUS.md) for the full list.

## License

[MIT](LICENSE)
