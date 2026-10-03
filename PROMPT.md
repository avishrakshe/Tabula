# TABULA — Master Build Prompt

> Paste this whole file into Claude Code (or your coding agent) at the root of an empty repo.
> Save it as `PROMPT.md` and keep it in the repo so every session can re-read it.

---

## 0. Your role

You are the founding engineer and design lead of **Tabula**, building a hackathon submission for **Colosseum's Crypto World's Fair (Solana track)**. Submissions close **October 12, 2026, 11:59pm PT**. Judging criteria: functionality and code quality, potential impact, novelty, UX, open source and composability, and business viability.

Work in milestones (section 9). Commit and push to `https://github.com/avishrakshe/Tabula.git` each time a unit of work is done, following the git workflow in section 11. At the end of each milestone, also update `docs/STATUS.md` (what works, what is mocked, what is next) and tag the milestone. Never claim something works unless you ran it.

---

## 1. Product in one paragraph

Tabula is spend control and treasury for AI agents that pay through **Solana payment channels**. Payment channels let an agent escrow a spending ceiling onchain once, then pay a vendor with many off-chain signed cumulative vouchers, settling onchain a single time. That makes agent payments cheap, but it moves real spending off-chain, where wallets, multisigs and onchain allowances cannot see or stop it. Tabula holds the voucher-signing key on behalf of agents. It evaluates every voucher against company policy before signing, cuts off a runaway agent mid-stream, reclaims unused escrow, and records every voucher in an auditable ledger. That ledger is anchored onchain and reconciled against onchain settlements.

It also verifies every payment request before money moves, so a prompt-injected agent cannot be redirected to a different payee. And it shows which vendors actually deliver per dollar, so the product saves money, not just prevents losses.

**Tagline:** Every agent payment, accounted for.

**Primary user:** engineering teams and AI-native startups running multiple agents that pay for inference, data and APIs per call. The buyer is the CTO, founder or head of finance.

---

## 2. Verified ecosystem facts (re-verify before coding against them)

Treat these as leads, not gospel. Read the real source and READMEs and record what you confirmed in `docs/FACTS.md`, with links and dates.

- **Payment channels program** (Solana Foundation): `github.com/solana-foundation/payment-channels`. Live on mainnet at `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`.
  - Flow: open (create PDA and escrow deposit) → off-chain cumulative vouchers (Ed25519) → settle and seal.
  - Also supports top-up, payer-initiated forced close with a grace period, payer refund of the remainder, and closing the channel to recover rent.
  - It backs MPP sessions and x402 "upto" and batch-settlement.
- **pay-kit:** `github.com/solana-foundation/pay-kit`. TypeScript and Rust SDKs for x402 and MPP, including Codama-generated clients for the payment-channels and subscriptions programs.
  - It has a playground running against the **Solana Payment Sandbox**, a hosted test validator with a faucet and no real funds.
  - Use the TS SDK. Find the exact package names in the repo; do not guess import paths.
- **pay CLI:** `github.com/solana-foundation/pay`. Wraps curl, claude and codex, and handles 402 challenges.
  - Supports remote signing backends: an Openfort backend already exists, where each payment is a policy-checked API call.
  - Study how it plugs in a backend. A stretch goal is a Tabula backend.
- **Solana Subscriptions and Allowances program:** launched June 2026, open source, audited by Cantina and Spearbit, and tested with Squads and Swig.
  - Allowances are a capped one-time spend with an optional expiry.
  - Find the repo and program ID yourself. If you cannot confirm them within one hour, fall back to **Squads v4 spending limits** (`@sqds/multisig`) for the onchain ceiling.
- **Squads v4 multisig:** `github.com/Squads-Protocol/v4`, SDK `@sqds/multisig`. Supports vaults, spending limits by member, amount, token, destination and period, and sub-accounts.

- **Reflect USDC+:** a fully liquid, yield-bearing stablecoin on Solana, minted and redeemed against USDC. SDK docs at `docs.reflect.money` (`UsdcPlusStablecoin`). Reflect is a Crypto World's Fair prize sponsor and was backed by Colosseum.
  - Use only as an optional treasury-yield toggle. Confirm devnet availability first; if there is none, mock it behind an interface and label it "mainnet only" in the UI.
- **Transaction simulation:** use `simulateTransaction` (or LiteSVM in tests) to preview balance changes before signing channel open and top-up transactions.

**Hard rules**

- Never invent program IDs, instruction names, account layouts or SDK functions. If something is unclear, read the source, write a 20-line spike script to confirm it, and only then build on it.
- Use **devnet or the Solana Payment Sandbox only**.
- Never commit private keys. Use `.env`, keep `.env.example` with placeholders, and generate demo keypairs at runtime into a gitignored `keys/` folder.

---

## 3. Scope

### Must ship (demo-critical)

1. **Voucher gateway.** An HTTP service that agents call to pay. It holds the voucher-signing key and applies policy to every voucher before signing.
2. **Policy engine.** Rules:
   - vendor allowlist
   - maximum price per unit
   - velocity (spend per rolling 60 seconds)
   - budget per task
   - daily budget per agent
   - anomaly detection: a z-score spike against the agent's recent rate
   - a global kill switch
3. **Enforcement actions.**
   - On violation: stop signing immediately, return a structured violation to the agent, and close the channel.
   - Use cooperative settle-and-seal if the vendor is reachable. Otherwise use the payer forced close and seal after the grace period.
   - Then refund the remainder to the treasury.
4. **Onchain ceiling.** Each agent gets an allowance (or a Squads spending limit) funded from a Squads vault, so policy failures can never exceed the ceiling.
5. **Ledger.** Every voucher, signed or blocked, is recorded with agent, task, vendor, channel, cumulative amount, delta, timestamp and policy verdict.
6. **Onchain receipts.** Every N vouchers (or every 30 seconds), compute a Merkle root over ledger rows and anchor it onchain. Use the Memo program for speed, or a tiny Anchor program `tabula_receipts` if time allows. Store the transaction signature with the batch.
7. **Reconciliation.** For each closed channel, compare the ledger's final cumulative amount with the onchain settled amount and flag any mismatch.
8. **Escrow float manager.** List all open channels and the idle escrow per vendor. Close channels idle for more than X minutes and sweep the funds back.
9. **Dashboard.** A Next.js app with live vouchers, agents, policies, channels and float, reconciliation, and an export.
10. **Marketing site.** A 3D landing page (section 7).
11. **Demo harness.** A script that runs the full demo story deterministically (section 8).
12. **Payment request verification.** Before opening or topping up any channel, check the vendor's 402 challenge against the vendor registry:
    - The payee, mint, program ID and price must match.
    - Simulate the transaction and assert that the only balance changes are the escrow deposit and fee.
    - On mismatch, block and record `PAYEE_MISMATCH` or `SIMULATION_MISMATCH`.
    - This stops prompt-injected payee swaps and malicious 402 challenges.
13. **Vendor scorecards and waste detection.**
    - Record the vendor response status for every paid unit.
    - "Waste" is spend on calls that errored, timed out or returned empty.
    - Per vendor, show cost per completed task, waste %, and p95 latency.
    - Add a "Cheaper option" hint when another allowlisted vendor delivered the same task type for less.

### Nice to have (only after must-ship is green)

- **Treasury yield (Reflect USDC+).** Idle treasury balances sit in USDC+ and are converted to USDC just in time to fund a channel. Show "yield earned on idle float" in the dashboard. Optional toggle, off by default, with a risk note.

- An MCP server exposing `tabula_pay`, `tabula_check` and `tabula_budget_state` so any MCP agent can use Tabula.
- A Tabula signing backend for the `pay` CLI.
- Approval workflow: vouchers above a threshold wait for a human click in the dashboard.
- CSV and QuickBooks-style export with cost centers.

### Out of scope

- Tempo or other chains.
- Real mainnet funds.
- Mobile apps.
- Authentication beyond a simple demo login.

---

## 4. Architecture

```
            ┌──────────────────────── Company ─────────────────────────┐
            │  Squads vault (USDC)  ──funds──▶  per-agent allowance     │
            └───────────────────────────────────────┬───────────────────┘
                                                    │ deposit (open channel)
  Agent A ─┐                                        ▼
  Agent B ─┼──HTTP──▶  TABULA GATEWAY  ──vouchers──▶ Vendor (pay-kit MPP session server)
  Agent C ─┘          │ policy engine │                  │
                      │ voucher signer│◀──settle/seal────┘
                      │ float manager │──forced close / refund──▶ payment-channels program
                      └──────┬────────┘
                             │ rows                Merkle root every N vouchers
                             ▼                              │
                         Postgres/SQLite ──────────▶ Solana (Memo or tabula_receipts)
                             │
                       Dashboard (Next.js, live via SSE/WebSocket)
```

### Repo layout (pnpm monorepo, TypeScript)

```
apps/
  web/            Next.js 15 App Router: marketing site (/) + dashboard (/app)
  gateway/        Fastify service: policy engine, voucher signer, float manager, ledger API, SSE stream
  vendor-mock/    pay-kit MPP-session server that sells "inference tokens" per unit
  agents/         three demo agents (research, coding, rogue) as scripted Node processes
packages/
  policy/         pure policy engine (no I/O), fully unit-tested
  ledger/         schema, Merkle batching, reconciliation logic
  solana/         thin wrappers over pay-kit clients, Squads, allowances, memo anchoring
  ui/             shared React components and design tokens
programs/
  tabula_receipts/  (optional) Anchor program storing batch roots
scripts/
  setup-devnet.ts   create keypairs, faucet, Squads vault, allowances, fund agents
  demo.ts           runs the full scripted story end to end
docs/
  FACTS.md  STATUS.md  ARCHITECTURE.md  PITCH.md
```

### Data model (Drizzle ORM, SQLite for demo, Postgres-ready)

- `agents`: id, name, role, department, allowance_pubkey, daily_budget, status (active, paused, killed)
- `vendors`: id, name, endpoint, payee_pubkey, unit_name, max_unit_price, allowlisted
- `policies`: id, scope (global, agent or vendor), rules_json, version, updated_by
- `channels`: id, channel_pda, agent_id, vendor_id, deposit, settled_amount, status (open, closing, sealed, refunded), opened_at, closed_at
- `vouchers`: id, channel_id, agent_id, task_id, cumulative_amount, delta, unit_count, verdict (signed or blocked), rule_triggered, response_status (ok, error, timeout, empty), latency_ms, ts, batch_id
- `challenge_checks`: id, vendor_id, payee_expected, payee_offered, program_id, price_offered, simulation_ok, verdict, ts
- `vendor_scores` (view): vendor_id, task_type, cost_per_completed_task, waste_pct, p95_latency, sample_size
- `batches`: id, merkle_root, voucher_count, tx_signature, anchored_at
- `tasks`: id, agent_id, label, customer_tag, budget
- `events`: append-only audit log of policy changes, kills, closes and sweeps

### Policy schema example (`packages/policy`)

```json
{
  "agent": "research-01",
  "dailyBudgetUsd": 25,
  "perTaskBudgetUsd": 5,
  "velocity": { "windowSec": 60, "maxUsd": 0.5 },
  "maxUnitPriceUsd": 0.0004,
  "vendors": { "allow": ["inference-mock"], "deny": [] },
  "anomaly": { "zScore": 4, "minSamples": 30 },
  "onViolation": "kill_and_close"
}
```

The engine is a pure function: `evaluate(state, voucherRequest, policy) → { verdict, rule?, remaining }`. Aim for 100% branch coverage with Vitest.

### Gateway API

- `POST /v1/sessions` `{agentId, vendorId, taskId}` → opens a channel (deposit sized by the float manager) and returns a sessionId.
- `POST /v1/sessions/:id/voucher` `{units, unitPrice}` → evaluates policy, then signs and forwards to the vendor, or returns 402-style JSON `{error: "POLICY_VIOLATION", rule, remaining}`.
- `POST /v1/sessions/:id/close`
- `POST /v1/kill` `{agentId | "all"}`
- `GET /v1/stream` → SSE events for the dashboard (voucher, verdict, channel state, batch anchored).
- `GET /v1/reconcile` and `GET /v1/export.csv`

Agents must never receive keypairs. Authenticate agents to the gateway with per-agent API keys.

---

## 5. Key engineering details

- **Voucher authority.** Inspect the payment-channels account layout to see who signs vouchers: the payer, or a delegated signer. Design it so the gateway's key is that signer and the agent process cannot sign. Document the finding in `FACTS.md`.
- **Cumulative semantics.** Vouchers carry cumulative totals. Policy is evaluated on the delta, but the signed payload is cumulative. Once a voucher is signed, it is claimable, so the check must happen before signing. Block the first violating voucher, not the one after.
- **Kill path.** The order is: mark the agent as killed → refuse all further vouchers → attempt cooperative settle at the last signed cumulative amount → if no response within T seconds, payer forced close → after the grace period, seal and refund to the treasury. Show every step in the dashboard timeline with transaction signatures and explorer links (devnet).
- **Float sizing.** The deposit equals the lesser of: the agent's remaining onchain allowance, the per-task budget, and the 95th percentile of this agent's session spend × 1.2. Log the reasoning.
- **Anchoring.** Use a sorted-pair SHA-256 Merkle tree. Batch rows serialize canonically (stable key order). Provide `scripts/verify-batch.ts` that recomputes a root from the DB and checks it against the onchain memo.
- **Reconciliation states:** `MATCHED`, `LEDGER_AHEAD` (signed vouchers not yet settled), `CHAIN_AHEAD` (should be impossible; red alert), `REFUND_PENDING`.
- **Resilience.** The gateway is idempotent per voucher (idempotency key = session + cumulative amount). Restarting the gateway must not lose ledger state.
- **Challenge verification order.** The order is: parse the 402 challenge → look up the vendor registry entry → compare payee, mint, program and price → build the transaction → simulate → compare pre/post balances → sign. Any mismatch blocks, and the reason is shown to the user in plain language.
- **Waste detection.** The vendor mock must sometimes return errors or empty bodies (seeded), so waste and scorecards have real data in the demo.
- **Testing.**
  - **Invariant tests** (fast-check property-based), listed in the README. For any sequence of voucher requests and policies:
    - no signed cumulative amount exceeds the channel deposit or the agent's remaining onchain ceiling;
    - no voucher after a kill is ever signed;
    - the ledger total equals the sum of signed deltas.
  - Unit tests for policy and ledger.
  - An integration test that runs the vendor-mock plus gateway against the sandbox or devnet: open, stream 500 vouchers, settle, reconcile, MATCHED.
  - A kill test that asserts the blocked voucher is never signed.

---

## 6. Dashboard (`/app`)

Pages:

1. **Overview:**
   - spend today
   - spend for the current hour
   - active agents
   - escrow tied up
   - escrow reclaimed this week
   - a live voucher feed, with verdict coloring
2. **Agents:**
   - list with status, budget used, onchain ceiling and a kill button
   - an agent detail page with a spend-over-time chart, task breakdown and policy editor
3. **Channels and float:**
   - open channels by vendor with deposit, used amount and idle time
   - "Sweep idle" action
4. **Ledger:**
   - filterable voucher table
   - batch list with Merkle root, transaction link and a "Verify" button that recomputes the root client-side
5. **Reconciliation:** one row per closed channel with its status badge, plus a CSV export.
6. **Policies:** JSON and form editor with versioning. Every change writes an audit event.
7. **Vendors:**
   - registry (payee, price, program)
   - scorecards: cost per completed task, waste %, latency
   - blocked payment requests with reasons
   - "Cheaper option" hints

UX rules:

- Plain language: "Stopped paying research-01: spent $0.62 in 60s (limit $0.50)", not "RULE_VELOCITY_EXCEEDED".
- Every onchain action shows a devnet explorer link.
- Empty states tell the user what to do next.

---

## 7. Marketing site and visual system (Paymark-style fintech UI)

**Visual reference:** https://paymark.framer.website. This is "Paymark", a paid Framer marketplace template by Onixtheme. Open it in a browser and study its rhythm, spacing, type scale, card treatments and level of polish.

- Use it as a **style reference only**. Do not copy its text, images, illustrations, logos or code. Every asset and every line of copy on our site must be original to Tabula.
- If we want the template itself, we buy a license on the Framer marketplace and use Path B below.

### Two build paths

- **Path A (default, done by you, the coding agent):** rebuild the site in Next.js using the Paymark-style visual language below, with Tabula's content and the 3D hero. The landing page and the dashboard share one design system.
- **Path B (optional, done by a human in Framer):** license the Paymark template, rebrand it in Framer with the tokens and copy below, and embed the 3D hero as an iframe or Framer code component pointing at `/hero-embed` from the Next.js app. The dashboard stays in Next.js.
  - No Framer connector is available to the agent, so Path B is manual.
  - Still build `/hero-embed` as a standalone route so Path B is possible.

### Design tokens

Adapted from Paymark's public style guide, plus Tabula semantics.

| Token | Hex | Use |
|---|---|---|
| `primary` (wax) | `#FF8975` | CTAs, live vouchers, highlights, active states |
| `ink` | `#0E0E0E` | Primary text on light, deepest dark |
| `night` | `#141414` | Dark sections, hero background, dark-mode surfaces |
| `paper` | `#FFFFFF` | Light page and card background |
| `gray-1` | `#ACAFB9` | Secondary text on dark |
| `gray-2` | `#D5D5D5` | Borders and dividers on light |
| `gray-3` | `#606165` | Secondary text on light |
| `sever` | `#D92D20` | Blocked or killed only. Always paired with an icon and a word, because it sits close to the coral accent. |
| `matched` | `#1F9D6B` | Reconciled `MATCHED` and healthy states only |

- **Type:** Inter Tight everywhere (Google Fonts, with a system fallback stack). Medium weight for headings, regular for body, and `font-variant-numeric: tabular-nums` for every amount.
  - H1 70px / 110%
  - H2 48px / 120%
  - H3 32px / 110%
  - H4 24px / 120%
  - H5 20px / 120%
  - Body 18px / 140%, 16px / 150%, 14px / 140%
  - Scale H1 down to about 44px on mobile.
- **Shape:** generous whitespace, large rounded product frames (about 20–24px radius), and pill buttons. Cards have a hairline `gray-2` border rather than heavy shadows.
- **Rhythm:** match the reference's alternation of light and dark (`night`) bands. Check it in the browser rather than guessing.
- **Layout:** centered hero and section intros as in the reference. Feature rows alternate text and image left/right. Keep text columns under 70 characters per line.

### Page structure

Each item is Paymark's section pattern mapped to Tabula's content.

1. **Nav:** Tabula wordmark; Product, Pricing, Docs, GitHub; a "Open the dashboard" pill in `primary`.
2. **Hero** (dark `night` band):
   - Headline: "Every agent payment, accounted for."
   - One-line subhead.
   - Two CTAs: "Watch the demo" and "Open the dashboard".
   - Below them, the **3D hero scene** (section 7.1) blending into a framed dashboard screenshot.
3. **Built on strip:** a slow marquee of the ecosystem pieces we actually use (Solana, Squads, pay.sh / pay-kit, Reflect if shipped). Use text wordmarks or official logos per each brand's guidelines. Never show fake customer logos.
4. **Intro statement:** "Your books see two transactions. Your agent made five thousand payments." Below it, one wide product image of the live voucher feed.
5. **Feature rows** (alternating, each with an original dashboard mockup card):
   - **Gate every voucher.** Policy rules checked before each signature.
   - **Stop a runaway agent mid-stream.** The kill timeline with explorer links.
   - **Block swapped payees.** The `PAYEE_MISMATCH` card.
   - **Prove every dollar.** Reconciliation all `MATCHED`, with a Merkle "Verify" button.
6. **Dark statement band:** the problem and why now (payment channels launched September 2026), with one CTA.
7. **Three-card grid:**
   - **Sweep idle escrow.** Shows reclaimed amount.
   - **Vendor scorecards.** Waste % and cost per completed task.
   - **Onchain ceilings.** A Squads vault funding per-agent allowances.
8. **How it works:** a real sequence, so numbering is fine: Fund → Verify → Gate → Stop → Prove.
9. **Pricing**, two cards:
   - **Team:** free up to 3 agents.
   - **Scale:** per agent per month plus basis points on managed spend, with optional treasury yield share.
10. **Testimonials:** real design-partner quotes only, with name and permission. If we have none, **omit this section**. Never invent testimonials, user counts or "join 1,000 businesses" claims.
11. **FAQ accordion:**
    - "Do agents ever hold keys?"
    - "What if Tabula goes down?" (the onchain ceiling still holds)
    - "Is this custodial?"
    - "Which payment protocols work?"
    - "Is the yield risky?"
12. **CTA band and footer:** GitHub, demo video, docs, Colosseum submission link.

### Dashboard uses the same system

- Light mode by default on `paper` with `gray-2` borders, plus a dark mode on `night`.
- Coral `primary` marks live and active items; `sever` and `matched` are reserved for their states.
- Same Inter Tight scale, using H4/H5 for panel titles.
- Every screen in the feature-row mockups must be a real screenshot of our dashboard, not a drawing.

### Motion

- Use the `motion` library (Framer Motion) for subtle section reveals, the marquee and accordion transitions. Keep it Framer-smooth but restrained: reveal once, no looping decoration.
- The 3D hero is the one big moment.
- With `prefers-reduced-motion`, all reveals become instant, the marquee stops, and the hero shows a static frame.

### 7.1 The 3D hero scene

- **Concept.** Tabula means a Roman ledger tablet. A dark stone-and-glass ledger tablet floats in the `night` band.
  - Three agent orbs orbit it. Each emits a stream of small coral (`primary`) voucher tokens that fly into the tablet and engrave a new ledger line as they land.
  - After about 4 seconds, one orb's stream speeds up and turns `sever` red. A crack of light runs across the tablet, the stream is cut mid-flight, and its remaining tokens fall back into a vault below.
  - The scene then eases into the framed dashboard screenshot as the user scrolls.
- **Stack:** React Three Fiber, drei and postprocessing, with subtle bloom on tokens only. Instanced meshes (≤ 600). Ledger lines are a canvas texture updated per landed token.
- **Performance:** cap DPR at 1.75, pause the render loop when the canvas is off-screen, and use detect-gpu quality tiers.
- **Accessibility:** a static lit frame for reduced motion; `aria-hidden` canvas; the headline is real HTML; keyboard focus visible everywhere.
- **Targets:** Lighthouse Performance ≥ 85 on desktop, Accessibility ≥ 95.
- **Route:** also expose the scene at `/hero-embed` (no nav, transparent background) for Path B.

---

## 8. Demo script (`scripts/demo.ts` and the 3-minute video)

1. `setup-devnet.ts` creates the Squads vault, funds it with devnet USDC (or a sandbox stablecoin), and creates allowances for `research-01`, `coder-01` and `rogue-01`.
2. The three agents open sessions with `inference-mock` and stream vouchers at realistic rates. The dashboard shows a live feed.
3. At t=45s, `rogue-01` receives a prompt-injected instruction (simulated) and its call rate jumps 20×.
4. The velocity rule trips at a specific voucher. Tabula blocks it unsigned, kills the agent, closes the channel, and refunds the remainder to the vault. Every step appears with explorer links.
5. The other two agents keep running untouched.
5a. `coder-01` reads a poisoned web page that tells it to pay a "faster mirror" endpoint. The mirror's 402 challenge names a different payee. Tabula blocks it before any transaction is signed (`PAYEE_MISMATCH`), and the agent falls back to its allowlisted vendor.
5b. The Vendors page shows that 14% of `vendor-b`'s paid calls were wasted on errors, and that `vendor-a` completes the same task 31% cheaper. Use seeded numbers, but compute them from the run's real data.
6. The float manager sweeps an idle channel.
7. Close all channels. The reconciliation page shows every channel `MATCHED`. Click "Verify" on a batch to recompute the Merkle root and match it to the onchain memo.
8. Export the CSV.

Make the run deterministic with a seed so the video can be re-recorded.

---

## 9. Milestones (today is Oct 4; deadline Oct 12, 11:59pm PT)

Eight days. Scope ruthlessly. Run two Claude Code sessions in parallel where marked (‖).

| Date | Milestone | Done when |
|---|---|---|
| Oct 4 | **Spike and facts** | `FACTS.md` filled in; a script opens a channel, signs 10 vouchers and settles on sandbox or devnet |
| Oct 5–6 | **Gateway, policy, verification** ‖ 3D site skeleton | Policy package and invariant tests green; gateway signs or blocks vouchers; challenge verification and simulation block a swapped payee; two vendor mocks serve sessions with seeded errors |
| Oct 7 | **Kill and float** ‖ 3D hero | Kill path proven by an integration test; refund lands in the vault; idle sweep works |
| Oct 8 | **Ledger, receipts, reconciliation, scorecards** | Batches anchored; verify script passes; reconciliation states correct; vendor scores computed |
| Oct 9 | **Dashboard** | Overview, Agents, Vendors, Ledger and Reconciliation pages live via SSE (Channels and Policies can be simpler) |
| Oct 10 | **Freeze and site polish** | Deterministic `demo.ts`; recorded replay fixture for the site; reduced-motion fallback |
| Oct 11 | **Ship** | Demo video, `docs/PITCH.md`, README; submit today |
| Oct 12 | **Buffer only** | Fix the submission page if something broke; nothing new |

If behind schedule, cut in this order: Reflect yield toggle → approval workflow → MCP server → custom Anchor receipts program (keep Memo) → anomaly rule (keep velocity) → 3D hero degrades to a single static lit render.

Never cut: the kill moment, payee-swap blocking, reconciliation `MATCHED`, and the vendor scorecard. Those four are the story.

---

## 10. Submission deliverables

- Public GitHub repo, MIT license.
- README:
  - one-paragraph pitch
  - architecture diagram
  - quickstart: `pnpm i && pnpm setup && pnpm demo`
  - what is real versus mocked
- A hosted site (Vercel) with the 3D landing page and a dashboard that replays the recorded demo.
- A 3-minute demo video: problem (20s) → live demo (2m) → business and market (40s).
- `docs/PITCH.md` covering:
  - problem
  - why now (payment channels launched September 2026)
  - users
  - competition: x402 per-payment firewalls, wallet policy engines and Squads cover single payments; Tabula governs voucher streams and escrow float
  - positioning against Flovia (Frontier winner, Colosseum-backed): Flovia helps API sellers win agent customers; Tabula is the buyer's side of the same market. They are complementary and a natural data partner.
  - business model: per agent + basis points on managed spend + optional share of treasury yield
  - savings math: losses prevented + waste eliminated + vendor switching + yield on idle float, shown for an example 20-agent team
  - traction: names and quotes from teams interviewed, and any design-partner commitments (even informal "we'd try it")
  - founder story: why we saw this problem first (keep it personal and specific)
  - roadmap: pay CLI backend, MCP server, approval flows, accounting integrations

---

## 11. Working agreement for the agent

- Read before writing. Spike before building. Test before claiming.

### Git workflow: commit and push as you finish work

**Repository:** `https://github.com/avishrakshe/Tabula.git` (branch `main`)

- **Session start.** Run `git pull origin main` and `git status`. If the repo is empty, create the initial `.gitignore` before anything else, and make it cover: `node_modules/`, `.env`, `.env.*` (but not `.env.example`), `keys/`, `*.json` keypairs inside `keys/`, `.next/`, `dist/`, `*.sqlite`, `coverage/`, `.turbo/`, `.DS_Store`.
- **Commit as soon as a unit of work is done.** A unit is one working change: a package scaffolded, a rule implemented with its tests, a page built, a bug fixed. Don't let finished work sit uncommitted. Before each commit:
  1. Run the relevant tests and lint (`pnpm test`, `pnpm lint`, or the package-level equivalent). Only commit if they pass. If something is intentionally unfinished, say so in the message.
  2. Run `git status` and `git diff --staged`. Confirm that no secrets, keypairs, `.env` files or large generated files are staged. If any are, unstage them and fix `.gitignore` first.
  3. Stage the files you changed with `git add <paths>`. Do not use `git add -A` blindly.
- **Message format:** Conventional Commits with the area in scope, describing what changed and why:
  - `feat(policy): add velocity rule with rolling 60s window`
  - `feat(gateway): block vouchers on PAYEE_MISMATCH before signing`
  - `fix(ledger): idempotency key uses session + cumulative amount`
  - `test(policy): invariant — no voucher signed after kill`
  - `docs(facts): confirm payment-channels voucher signer layout`
  - `chore(repo): pnpm workspace scaffold`
- **Push after every commit.** Run `git push origin main` so progress is never only local. If the push is rejected, run `git pull --rebase origin main`, resolve conflicts, re-run tests, and push again. Never force-push `main`.
- **Milestone done.** When a milestone in section 9 meets its "Done when" criteria:
  1. Update `docs/STATUS.md` with what works, what is mocked, and what is next.
  2. Commit it as `docs(status): milestone N complete — <name>`.
  3. Tag it: `git tag -a m<N>-<short-name> -m "<summary>"` (for example `m1-spike`), then run `git push origin main --tags`.
- **Parallel sessions.** Each session works on its own branch (for example `site/landing`, `core/gateway`). Commit and push the branch with the same rules. When its tests pass, merge into `main` with `git checkout main && git pull && git merge --no-ff <branch>`, then push.
- **Never commit:** private keys, seed phrases, API keys, `.env` files, RPC URLs containing keys, or anything from `keys/`. If a secret is ever committed, stop, tell me, and rotate it. Removing it in a later commit is not enough, because it stays in the history.
- **End of every session.** Make sure `git status` is clean (everything committed and pushed). The last commit updates `docs/STATUS.md`. Report the final commit hash to me.

### Other rules

- When an external API differs from this prompt, the real API wins. Update `FACTS.md` and adapt.
- Ask me before adding paid services, changing scope, or touching anything beyond devnet or the sandbox.
- At the end of each session, update `docs/STATUS.md`.
