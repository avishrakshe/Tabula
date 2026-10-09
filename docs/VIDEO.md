# Demo video: 3 minutes

Structure (from the plan): problem (20 s) → live demo (2 min) → business and market (40 s).

## Setup before recording

Record from the hosted site, or locally with `pnpm --filter @tabula/web build && pnpm --filter @tabula/web start`.

- **The replay needs no gateway.** Open `/app?replay&theme=dark`, or jump to a moment with `&t=<seconds>`
  (the replay opens paused there).
- **For a live take,** run `pnpm demo --hold` and open `/app`. A live run follows the same timeline, at
  roughly the same times.
- **Speed:** the replay plays at 4× by default. Use 1× for the kill (0:45 to 1:05).

## Shot list

| Time | Screen | Say (roughly) |
|---|---|---|
| 0:00–0:20 | Landing page hero (`/`): the tablet, the red stream, the crack | "Agents can pay per call now. Payment channels move that spending off-chain, where nobody's watching. One prompt injection and the escrow's gone." |
| 0:20–0:35 | Dashboard overview, replay at 0:23 | "Three agents, each paying a vendor through a Solana payment channel. Tabula holds their keys and checks every voucher before it signs." |
| 0:35–0:50 | Vendors page, the `PAYEE_MISMATCH` card (`t=30`) | "coder-01 followed a poisoned link to a 'faster mirror'. Its payment request named a different payee, so it was blocked before anything was signed." |
| 0:50–1:25 | Agent rogue-01 (`/app/agents/rogue-01`, `t=45`, 1×): the trailing-window chart climbs to the limit, then the blocked voucher and the kill timeline | "rogue-01 reads an injected ticket and calls as fast as it can. Voucher 49 would cross the limit, so it's refused unsigned. The agent is stopped, the channel closes at the last signed voucher, and $0.565 goes back to the treasury." |
| 1:25–1:40 | Channels & float (`t=125`): the idle channel closed | "The float manager closes a channel nobody is using and reclaims its escrow." |
| 1:40–2:05 | Ledger (`t=168`): click Verify on a batch; MATCHED | "Every 40 vouchers, Tabula anchors a Merkle root onchain. Verify recomputes it here, in your browser." |
| 2:05–2:20 | Reconciliation (`t=168`): 4/4 MATCHED; then Vendors scorecards | "Every channel reconciles against what settled. And the scorecards show inference-b wasted 9% of its paid calls; inference-a does the same task 26% cheaper." |
| 2:20–3:00 | Landing page: three cards, how it works, pricing | Who it's for, the business model (per agent + basis points on managed spend), the roadmap, and one line on why now (payment channels launched Sept 3, 2026). |

Keep claims to what the run shows: every number above is in the recording.
