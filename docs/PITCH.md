# Tabula: the pitch

**Every agent payment, accounted for.** Spend control and treasury for AI agents that pay through Solana
payment channels.

> Numbers marked *measured* come from the recorded demo run on the Solana Payment Sandbox
> (`apps/web/public/replay/demo.json`, 2026-10-04). Numbers marked *assumption* are inputs to an example and
> should be replaced with real ones. Sections marked **TO FILL** need facts only the founders have.

## Problem

Agents are starting to buy things on their own: inference, data, search, tools. Payment channels make that
cheap. An agent escrows a deposit once, then pays a vendor with signed vouchers off-chain, thousands per
session, and settles in a single transaction.

That moves real spending to a place nobody watches:

- **The books see two transactions per channel** (open and close). Everything in between is invisible to
  wallets, multisigs and accounting.
- **A prompt-injected agent spends at machine speed.** In our recorded run, rogue-01 went from a normal pace to
  calling as fast as it could within seconds of reading an injected ticket. Without a gate, its whole escrow is
  gone before a human looks.
- **A payment request can name the wrong payee.** A poisoned page told coder-01 about a "faster mirror"
  whose 402 challenge named a different payee. Without a check, the agent opens a channel and pays it.
- **Escrow is idle money.** Every open channel holds a deposit outside the treasury. Abandoned channels keep
  it there.
- **Paid calls fail.** Errors, empty responses and timeouts are still paid for. In the run, 9.1% of
  inference-b's paid calls were wasted (*measured*).

## Why now

- **Payment channels are live.** The Solana Foundation launched Payment Channels on
  [September 3, 2026](https://solana.com/news/payment-channels-1-million-payments-per-second). Per-call agent
  payments are now practical on mainnet, and the spending they enable is off-chain by design.
- **The onchain pieces for a hard ceiling exist.**
  - [Subscriptions & Allowances](https://solana.com/news/subscriptions-and-allowances) gives recurring onchain
    allowances.
  - Squads v4 holds the treasury.
  - Tabula combines them so each agent's daily ceiling holds onchain, even if every off-chain check failed.
- **Agent fleets are leaving the prototype stage.** Once a team runs tens of agents with real budgets, finance
  asks the questions Tabula answers: who spent what, on which vendor, for which task, and was it allowed?

## Users

- **Teams running agent fleets that pay per call:** AI-native startups and platform teams whose agents buy
  inference, data and tools from several vendors.
- **The person who owns the bill:** a founder, head of finance or controller. They need budgets, a kill switch
  and books that reconcile.
- **The engineer who owns the agents:** wants one API key per agent instead of wallets and keys scattered
  across services.

## Product (what the demo proves)

| | What happens | Measured in the run |
|---|---|---|
| Gate every voucher | Policy is checked before each signature; the guarded signer holds the keys | 244 vouchers signed, 1 blocked |
| Stop a runaway agent | The voucher that crosses the limit is refused unsigned, then the agent is stopped, its channel closed and the refund swept to the vault | voucher #49 blocked 13 s after the injection; $0.06 settled, $0.565 back to the vault |
| Block swapped payees | The 402 challenge is checked against the registry and the open is simulated | `PAYEE_MISMATCH`, nothing signed |
| Sweep idle escrow | The float manager closes channels nobody is using | $0.61625 reclaimed |
| Prove every dollar | Merkle roots are anchored with the Memo program, and each channel is reconciled against settlement | 7/7 batches verified, 4/4 channels `MATCHED`, vault down exactly the $0.25775 vendors settled |
| Vendor scorecards | Waste and cost per completed task | inference-b 9.1% waste; inference-a does the same task 27% cheaper |

## Competition

- **x402 per-payment firewalls** approve or deny one payment at a time.
- **Wallet policy engines** limit what a key may sign, one transaction at a time.
- **Squads spending limits** cap withdrawals from a multisig.

All three govern single payments. A payment channel is a **stream**: one onchain open, thousands of off-chain
vouchers, one close. The risk lives in the voucher stream and in the escrow float, which those tools can't see.
Tabula governs exactly that. It gates each voucher, manages the float, closes and refunds channels, and keeps a
ledger that reconciles against settlement. It uses Squads as the treasury rather than replacing it.

**Flovia** (Frontier winner, Colosseum-backed) helps API sellers win agent customers. Tabula is the buyer's
side of the same market. The two are complementary: vendor quality data from Tabula's scorecards (waste, cost
per completed task) is exactly what a seller-side platform wants to show, so it's a natural data partnership.

## Business model

- **Per agent per month**, free for up to 3 agents.
- **Basis points on managed spend:** the value scales with the money Tabula governs.
- **Optional share of treasury yield** on idle float, once that ships. This is opt-in and off by default.

Prices are not set yet (the site says "pricing on request"). **TO FILL:** the per-agent price and the basis
points, once tested with design partners.

## Savings math: an example 20-agent team

These are illustrative inputs, not customer data. The two rates marked *measured* come from the recorded run;
everything else is an *assumption* to replace.

| Line | Inputs | Monthly |
|---|---|---|
| Managed spend | 20 agents × $1,500/agent/month (*assumption*) | $30,000 spend |
| Losses prevented | 1 runaway incident per quarter (*assumption*); uncapped loss $2,000 per incident (*assumption*) vs. stopped at the velocity limit (the run stopped at $0.06) | ≈ $665 |
| Waste eliminated | 5% of spend paid for failed calls (*assumption*; the run *measured* 9.1% at one vendor), half of it avoided by routing and refusals | ≈ $750 |
| Vendor switching | 20% of spend movable to a cheaper vendor for the same task (*assumption*), 27% cheaper (*measured*) | ≈ $1,620 |
| Yield on idle float | $20,000 average idle treasury float (*assumption*) at 4% a year (*assumption*); planned feature | ≈ $67 |
| **Total** | | **≈ $3,100 a month** (≈ 10% of managed spend) |

The biggest lines are measurable from day one: Tabula's scorecards compute waste and cheaper options from the
team's own paid calls.

## Traction

**TO FILL (founders):**

- teams interviewed, with names, roles and quotes, used only with their permission;
- design-partner commitments, even informal ones ("we'd try it");
- anyone who ran the demo or the dashboard.

Never pad this section. If there is nothing yet, say so.

## Founder story

**TO FILL (founders):** why we saw this problem first. Keep it personal and specific: the moment an agent's
spend surprised you, the invoice nobody could explain, or the escrow that sat idle.

## Roadmap

1. **Pay CLI backend:** Tabula as the policy and custody backend for agent payment tooling.
2. **MCP server:** agents call Tabula as a tool, with budgets and receipts built in.
3. **Approval flows:** a spend above a threshold waits for a human, with one-tap approval.
4. **Accounting integrations:** ledger exports that land in the books by vendor, task and team.
5. **Automatic top-ups**, multi-vendor routing on scorecards, and treasury yield on idle float.
6. **Mainnet:** move from the sandbox to mainnet with design partners.

## Links

- Code: <https://github.com/avishrakshe/Tabula>
- Recorded run: the dashboard's replay (`/app?replay`) on the hosted site. **TO FILL:** the Vercel URL.
- Demo video: **TO FILL:** the link, once recorded (shot list in [`VIDEO.md`](VIDEO.md)).
