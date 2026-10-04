# TABULA — Deployment Prompt (Vercel + Supabase)

> Give this to Claude Code inside the Tabula repo **after** the core build works locally (`pnpm demo` runs end to end).
> Save it as `DEPLOY.md` next to `PROMPT.md`. `PROMPT.md` still governs everything else, including the git workflow in section 11.

---

## 0. Goal

Ship Tabula as a live, public, judge-ready product by **Oct 11, 2026**:

- **Marketing site** (3D hero, Paymark-style UI) at the root domain.
- **Dashboard** at `/app`, showing a real devnet run.
- **Live demo:** judges press "Run live demo" and watch agents pay, get gated, killed and reconciled on Solana devnet, with explorer links.
- **Replay mode:** if anything live fails, the site falls back to the recorded demo fixture automatically. The site must never show a broken state to a judge.

**Target stack:**

- Vercel hosts the Next.js app: site, dashboard and API route handlers.
- Supabase provides Postgres (data), Realtime (live feed), and pg_cron + pg_net (scheduled jobs).
- Everything Solana stays on **devnet / the Solana Payment Sandbox**. No mainnet, no real funds.

Before relying on any platform limit below, check it against current Vercel and Supabase docs and note what you confirmed in `docs/FACTS.md`. Limits change; the docs win.

---

## 1. Architecture changes for serverless

The local build uses a long-running Fastify gateway, SQLite and SSE. Serverless needs these changes:

| Local | Deployed | Why |
|---|---|---|
| Fastify gateway | Next.js **Route Handlers** under `apps/web/app/api/v1/*`, using the same `packages/policy`, `packages/ledger` and `packages/solana` code | One deploy on Vercel. The gateway logic stays in packages; only the transport changes. |
| SQLite (Drizzle) | **Supabase Postgres** (Drizzle `postgres-js` driver) | Persistent and shared across function instances. |
| SSE stream | **Supabase Realtime** (`postgres_changes` on `vouchers`, `channels`, `batches`, `events`) | Serverless functions shouldn't hold long open connections. |
| In-process timers (float sweeper, batch anchoring, forced-close follow-ups) | **Supabase pg_cron + pg_net** calling protected `/api/cron/*` endpoints every minute | Vercel Hobby crons are very limited (about once a day; verify). Supabase pg_cron runs every minute on the free tier. |
| Demo agents as local Node processes | `/api/demo/run`, which starts a bounded scripted run (≤ 90s), plus a client-driven tick loop if needed to stay inside function time limits | Judges can trigger it from the browser. |

Keep the Fastify app in the repo for local development, but make both transports call the same package functions. Don't fork the logic.

**Function limits.** Check the current max duration for Vercel functions on the plan we use. Design every API call to finish well under it. A long demo run is many short calls (one tick = a few vouchers), driven by the client or by cron. It is never one long call.

---

## 2. Supabase setup

1. Create a project named `tabula` in a region close to the Vercel function region.
2. **Database connection:**
   - Use the **transaction-mode pooler** connection string for serverless (`DATABASE_URL`, port 6543).
   - Set `prepare: false` in postgres-js, because transaction-mode pooling doesn't support prepared statements.
   - Use the **direct** connection string (`DIRECT_URL`) only for migrations.
3. **Migrations:** port the Drizzle schema to the `pg-core` dialect, generate migrations with `drizzle-kit`, and apply them with `drizzle-kit migrate` against `DIRECT_URL`. Commit the migration files.
4. **Row Level Security:** enable RLS on **every** table.
   - Public (anon) role: `SELECT` only on demo-safe views (`public_vouchers`, `public_channels`, `public_batches`, `public_vendor_scores`). These views contain no secrets, no API keys and no internal notes.
   - No anon `INSERT`, `UPDATE` or `DELETE` anywhere.
   - All writes go through server route handlers using the **service role key**, which never reaches the browser.
5. **Realtime:** add only the public views' underlying tables to the Realtime publication, then test that the anon client receives inserts.
6. **Cron:** enable `pg_cron` and `pg_net`. Schedule every minute:
   - `POST {SITE_URL}/api/cron/anchor` (anchor pending voucher batches)
   - `POST {SITE_URL}/api/cron/sweep` (close idle channels, follow up forced closes, refunds)
   - `POST {SITE_URL}/api/cron/reconcile`

   Each request sends header `Authorization: Bearer {CRON_SECRET}`. Store the secret in Supabase Vault, not in plain SQL.
7. **Seed:** add a `seed.ts` that creates the demo vendors, agents and policies, plus one completed historical run, so the dashboard is never empty.

---

## 3. Vercel setup

1. Install and log in to the Vercel CLI. Run `vercel link` from the repo root, and set the project **Root Directory** to `apps/web`. The monorepo builds with pnpm.
2. Set the build so workspace packages compile first (Turborepo or a `pnpm -r build` pre-step). Confirm `vercel build` works locally before deploying.
3. **Environment variables.** Set them for Production and Preview with `vercel env add`. Never commit them; mirror the names in `.env.example`.

| Name | Exposure | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | Read-only via RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Never prefixed `NEXT_PUBLIC_` |
| `DATABASE_URL` / `DIRECT_URL` | server only | Pooler / direct |
| `SOLANA_RPC_URL` | server only | Devnet or sandbox RPC. If it contains a provider key, keep it server-only. |
| `TABULA_GATEWAY_SECRET_KEY` | **server only** | Devnet voucher-signing keypair (base58). Generated fresh for deployment and never reused anywhere else. |
| `TREASURY_*`, `AGENT_*` keys | server only | Devnet demo keypairs |
| `CRON_SECRET` | server only | Checked by `/api/cron/*` |
| `DEMO_RUN_LOCK_SECONDS` | server only | Default 120 |
| `NEXT_PUBLIC_SITE_URL` | public | Final domain |

4. **Function region:** pin functions to the same region as Supabase.
5. **Deploy:** `vercel` (preview) → test everything in section 5 → `vercel --prod`.

---

## 4. Security and abuse protection for a public demo

- **Demo lock.** Only one live run at a time, enforced with a Postgres advisory lock or a `demo_runs` row with a TTL. While a run is in progress, other visitors watch that same run live instead of starting a new one.
- **Rate limit** `/api/demo/run` per IP using a simple Postgres counter table. Return a friendly "a run is in progress, watching it live" response.
- **Devnet funds watchdog.** Before each run, check the treasury and agent devnet balances.
  - If they are low, switch the site to replay mode, log an event, and show "Live demo is refueling; showing the latest recorded run."
  - Add `scripts/refuel-devnet.ts` for me to run manually (faucets are rate-limited).
- **No secrets client-side.** Grep the production build output (`.next/`) for every secret value's prefix, and fail the deploy check if any appear.
- **Security headers** in `next.config`: a CSP that allows only what we load (Google Fonts, Supabase URL, our own origin), `X-Content-Type-Options`, `Referrer-Policy`, and `frame-ancestors` (allow framing of `/hero-embed` only).
- The gateway API used by real agents (`/api/v1/*`) requires per-agent API keys. Store these hashed in Postgres and never return them after creation.

---

## 5. Pre-launch checklist (run on the preview URL, then again on production)

- [ ] Landing page loads, the 3D hero runs, and the reduced-motion fallback works. Lighthouse desktop: Performance ≥ 85, Accessibility ≥ 95.
- [ ] `/app` loads seeded data with no login needed for read-only viewing.
- [ ] "Run live demo" goes through the full story: vouchers stream → payee swap blocked → rogue agent killed → refund lands → idle sweep → all channels `MATCHED`. Every onchain step links to the devnet explorer and the links resolve.
- [ ] Two browsers open at once: the second one watches the same run live.
- [ ] Forcing a failure (bad RPC URL in a preview environment) makes the site fall back to replay mode cleanly.
- [ ] The cron endpoints reject requests without `CRON_SECRET`, and pg_cron calls succeed (check `cron.job_run_details`).
- [ ] The Merkle "Verify" button recomputes a root that matches the onchain memo.
- [ ] CSV export downloads.
- [ ] The secrets grep of the build output is clean.
- [ ] Mobile layout is checked at 380px width.
- [ ] Open Graph image and metadata are set (title "Tabula — Every agent payment, accounted for").

Record the results in `docs/STATUS.md` and commit (`chore(deploy): production launch checklist passed`). Tag the release `v1.0-submission`.

---

## 6. Domain

**Name options, in order of preference.** I (the human) check availability and buy the domain. You don't purchase anything.

1. `tabula.money`: short, says exactly what it does
2. `usetabula.com`: the classic startup pattern, most trusted
3. `tabula.cash`
4. `tabulaledger.com`
5. `gettabula.xyz`: a common Web3 TLD and usually cheap

Free fallback for the submission if no domain is bought in time: `tabula-agents.vercel.app` (rename the Vercel project to claim it).

**Once I've bought one:**

1. Add it in Vercel (Project → Domains), with both the apex and `www` pointing to the apex.
2. Set the DNS records Vercel shows (A / CNAME, or use Vercel nameservers).
3. Wait for HTTPS to issue.
4. Update `NEXT_PUBLIC_SITE_URL`, the pg_cron URLs, and the Supabase auth/CORS allowed origins.
5. Redeploy.
6. Put the final URL in the README and tell me, so I can paste it into the Colosseum form.

---

## 7. Hand-off

When done, report to me:

- production URL and commit hash
- what is live versus replay
- devnet balances remaining
- any limits you found (function duration, cron, Realtime) and how you worked around them
