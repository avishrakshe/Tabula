# FACTS — verified ecosystem facts

Every claim here was confirmed by reading upstream source or querying a live RPC, on the date shown.
Where this file disagrees with `PROMPT.md`, this file wins (the real API wins). Last updated **2026-10-04**.

## Upstream sources read

| Repo | Commit | Date |
|---|---|---|
| [solana-foundation/payment-channels](https://github.com/solana-foundation/payment-channels) | `3ffa4d6728ad88e4a9667a76ad9ccd68a302c696` | 2026-08-07 |
| [solana-foundation/pay-kit](https://github.com/solana-foundation/pay-kit) | `262c6b9a9f8b9d7b339e1ea83fe1b5a852f90ff5` | 2026-10-02 |
| [solana-foundation/pay](https://github.com/solana-foundation/pay) | `e22d0af4ea3989a3941a66b2eefe679cf6e38f1a` | 2026-10-01 |
| [solana-foundation/subscriptions](https://github.com/solana-foundation/subscriptions) | via npm `@solana/subscriptions@0.5.0` | 2026-08-10 |

## Program IDs (confirmed with `getAccountInfo`, 2026-10-04)

| Program | ID | Sandbox | Devnet | Mainnet |
|---|---|---|---|---|
| Payment channels | `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX` | yes | yes | yes |
| Subscriptions & allowances | `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44` | yes | yes | yes |
| Squads v4 | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` | yes | yes | — (not queried) |
| Memo | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` | yes | yes | — |
| USDC mint (mainnet) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | yes (cloned) | — | yes |
| USDC mint (Circle devnet) | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | — | yes | — |

## Solana Payment Sandbox

- Hosted surfnet at **`https://402.surfnet.dev:8899`** (`getVersion` → `surfnet-version 1.6.0`, `solana-core 4.2.2`).
  Source: pay-kit `playground/README.md` (`RPC_URL` default) and `typescript/examples/playground-api/sandbox.ts`.
- It **clones mainnet state lazily**, so the mainnet payment-channels build, Squads v4, Subscriptions and the
  mainnet USDC mint all exist there. No real funds: balances are written with cheatcodes.
- Funding cheatcodes (same as pay-kit's playground faucet):
  - `surfnet_setAccount(address, { lamports, data: '', executable: false, owner: System, rentEpoch: 0 })`
  - `surfnet_setTokenAccount(owner, mint, { amount, state: 'initialized' }, tokenProgram)`
- Explorer links: `https://explorer.solana.com/tx/<sig>?cluster=custom&customUrl=<rpc>` (pay-kit playground
  `useConfig.ts` uses `cluster=custom` for the sandbox). Devnet uses `?cluster=devnet`.
- **Decision:** Tabula's demo runs on the sandbox by default (`TABULA_CLUSTER=sandbox`). Devnet is supported by
  config, but needs SOL from the faucet and a test mint, because Circle devnet USDC is faucet-gated.

## Payment channels program

Source: `program/payment_channels/src/state/channel.rs`, `docs/003-program-instructions.md`, `README.md`.

- **Launch:** the Solana Foundation announced Payment Channels on 2026-09-03
  ([solana.com/news](https://solana.com/news/payment-channels-1-million-payments-per-second)). Press coverage
  notes that the "1 million payments per second" figure comes from a controlled benchmark, not mainnet
  throughput (checked 2026-10-04).

- **Channel PDA** seeds: `[b"channel", payer, payee, mint, authorized_signer, salt u64 LE, open_slot u64 LE]`.
  The 256-byte fixed layout (status, deposit, settled and payout watermarks, closure timestamp, grace period,
  distribution hash, payer, payee, authorized_signer, mint, rent_payer, open_slot).
  Escrow is `ATA(channel, mint)`.
- **Status enum:** `Open=0`, `Sealed=1`, `Closing=2`, `Distributed=3`. A deallocated PDA means fully closed.
- **`open_slot`** must satisfy `open_slot <= clock.slot` and `clock.slot - open_slot <= 1500`. It is part of the
  address, so every incarnation lands at a new address and old vouchers cannot replay.
- **Instructions** (discriminator, signer):
  `open` (1, payer + rent_payer), `settle` (2, permissionless + Ed25519 voucher), `topUp` (3, payer),
  `settleAndSeal` (4, payee, optional voucher), `requestClose` (5, payer), `seal` (6, permissionless after grace),
  `distribute` (7, permissionless), `withdrawPayer` (8, payer), `reclaim` (9, permissionless).
- **Voucher wire format** (50 bytes, Ed25519-signed): `[0x56, 0x01] || channel_id (32) || cumulative_amount
  u64 LE || expires_at i64 LE (0 = never)`. The settle tx carries a canonical single-signature Ed25519 precompile
  instruction immediately before `settle` / `settleAndSeal`. The program reads the voucher from the
  Instructions sysvar.
- **Voucher checks:** cumulative must be strictly greater than `settled` (234), at most `deposit` (235), signer
  must equal `authorized_signer` (237), not expired (233), channel id must match (232).
- **`distribute` from SEALED:** pays the payee its settled share, refunds the payer `deposit - settled` (unless
  `withdrawPayer` already ran), sweeps rounding dust to `ATA(TREASURY_OWNER, mint)`, and closes the escrow.
  It deallocates the PDA if `slot > open_slot + 1500`; otherwise it marks the PDA `Distributed` for `reclaim`.
- **Forced close timeline:** `requestClose` (payer) → grace period (per-channel `grace_period` seconds, set at
  `open`, must be non-zero) → `seal` (anyone) → `distribute`. The payee can still `settleAndSeal` with its best
  voucher during the grace window. After `seal` the watermark is locked, so a payee that never settled loses
  unsettled vouchers.
- **Treasury owner differs per cluster build:**
  - Mainnet build (and therefore the sandbox): `Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP`. Source: pay-kit
    `on-chain.ts` `TREASURY_OWNER_BYTES`. Confirmed: the bytes occur in the mainnet ProgramData ELF at offset 61576.
  - Devnet build: `4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap`. Source: `pay` `rust/crates/core/src/server/session.rs`
    and pay-kit `DEVNET_TREASURY_OWNER`. Confirmed: the bytes occur in the devnet ELF at offset 61480 (they are
    also the devnet upgrade authority).
  - The repo's `constants.rs` still shows a placeholder for devnet. The deployed binary is authoritative.

### Voucher authority (PROMPT §5) — the key finding

`authorized_signer` is a separate account bound at `open` and stored in the channel. It *"equals payer unless a
delegate was bound at open"* (`channel.rs`), and it does **not** need to sign `open`. So Tabula opens every
channel with `authorized_signer = <Tabula gateway voucher key>`, while `payer` is the agent's funding wallet.
Both keys live in the gateway, and agent processes receive neither.

**Proven by the M1 spike** (`pnpm spike`, sandbox, 2026-10-04):

- A channel was opened with payer ≠ authorized signer. The onchain `authorized_signer` was the Tabula key.
- A voucher signed by the **payer** key was rejected by the program with `VoucherSignerMismatch (237)`.
- A voucher above the deposit was rejected with `VoucherOverDeposit (235)`.
- Permissionless `settle` at voucher #5 set `settled = 0.125`. Replaying #3 was rejected with
  `VoucherWatermarkNotMonotonic (234)`.
- The payee ran `settleAndSeal` with #10, giving `settled = 0.25`. Then `distribute` paid the payee $0.25,
  refunded the payer $0.75, closed the escrow, and marked the channel `Distributed`.
- Sample transactions: open `53cwus9B…HUMV`, settle `3mnBRMkz…tdAc`, settle_and_seal `5JMk1Fpe…UKgr`,
  distribute `5tJGysFi…amjr` (sandbox; the explorer links are printed by the script).

Implication for policy: a voucher is claimable the moment it is signed, so policy must run **before** the gateway
signs. The program enforces only `cumulative <= deposit`, so the deposit size is itself a hard per-channel cap.

## TypeScript SDKs

- **`@solana/pay-kit`** (npm `0.13.0`, 2026-10-02). Server: `createPayKit({ network, operator, pricing })`, with
  `session(usd(cap), { unitPrice })` pricing, `pay.express(gate)` and `pay.sessionRoutes(gate)`. The published
  package **bundles** `@solana/mpp` (repo `0.11.0`) in its dist, but does not re-export the low-level session client.
  Peer deps: `@solana/kit >=6.5.0`, `mppx >=0.8.15`.
- **`@solana/mpp`** — npm latest is **`0.7.0` (2026-07-13)**, behind the repo's `0.11.0`. The session client
  (`createSessionFetch`, `createPaymentChannelSessionOpener`, `ActiveSession`) lives in `@solana/mpp/client`.
  - `createPaymentChannelSessionOpener({ signer, sessionSigner })` takes a separate `sessionSigner` for vouchers.
  - `SessionSigner = MessagePartialSigner` from `@solana/kit`. Tabula can wrap the voucher key in a
    policy-gated `MessagePartialSigner` whose `signMessages` refuses when policy denies.
  - Voucher-signer modes: `methodDetails.voucherSigner = 'client' | 'operator'`.
- **Payment-channels TS client** (`clients/typescript`, package `@payment-channels/client`) is **not on npm**.
  Tabula vendors the generated Codama client into `packages/solana/src/generated/` (provenance and one type
  patch are documented in that folder's README).
- **`@solana/kit`**: pay-kit pins and tests against **`6.10.0`**, and Tabula pins the same. (npm latest is 8.4.0.)
  Kit-6-compatible program clients: `@solana-program/token@0.13.0`, `system@0.12.2`, `compute-budget@0.15.0`.
  `@solana-program/memo` ≥ 0.12 requires kit ≥ 7, so Tabula builds memo instructions directly (data = UTF-8
  bytes, program `MemoSq4g…`).
- **`@solana/subscriptions`** — `0.5.0` needs kit `^7`; `0.4.0` / `0.3.0` peer on kit `^6.4.0` (not yet checked
  against the deployed program).

## Onchain ceiling: Subscriptions & Allowances program

Confirmed within the hour, so the Squads-spending-limit fallback is not forced.

- Repo `solana-foundation/subscriptions`, program `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`, live on the
  sandbox and devnet. SDK `@solana/subscriptions` (Kit plugin plus Codama builders).
- `initSubscriptionAuthority`: a per-mint SubscriptionAuthority PDA plus an SPL approve on the delegator's ATA.
- `createFixedDelegation({ delegatee, amount, expiryTs, nonce })`: **a one-time allowance with optional expiry.**
- `createRecurringDelegation`: a periodic allowance (amount per period). This maps directly to an onchain
  daily budget per agent.
- `transferFixed` / `transferRecurring`: the **delegatee signs** and pulls from `delegatorAta` into any
  `receiverAta`, capped by the delegation. `revokeDelegation` closes it.
- Tabula plan: the treasury (Squads vault) delegates to each agent's payer key. The gateway pulls just in time
  into the agent wallet before `open`/`topUp`, and sweeps refunds back to the treasury. Even if the policy
  engine fails, an agent can never pull more than its delegation.
- Fallback still available: Squads v4 spending limits (`@sqds/multisig@2.1.4`, which uses web3.js v1).
- **Proven by the ceiling spike** (`pnpm tsx scripts/spike-ceiling.ts`, sandbox, 2026-10-04):
  - Created a threshold-1 Squads v4 multisig and funded its vault with 100 USDC.
  - Vault transaction #1 ran `initSubscriptionAuthority` with the vault PDA as owner, via Squads CPI.
  - Vault transaction #2 ran `createRecurringDelegation`: $2.00 per 86,400 s to an agent wallet.
  - The agent pulled $1.50 with `transferRecurring`. A further $0.60 was rejected by the program with
    `AmountExceedsPeriodLimit (400)`.
- **The deployed program is older than the repo's HEAD** (`56de552`, 2026-10-02). Two HEAD features are
  rejected onchain:
  - The `UNKNOWN_INIT_ID` same-slot sentinel → `StaleSubscriptionAuthority (136)`. Fix: init the
    authority in one transaction, read its real `init_id` (the slot it was created in) from the account,
    and pass that.
  - `start_ts = 0` ("start on landing") → `RecurringDelegationStartTimeInPast (404)`. Fix: start a few
    seconds ahead of the cluster's Clock sysvar (`clusterUnixTime`), then wait for it before pulling.
- The `@solana/subscriptions` 0.5.0 instruction builders and account decoders work with `@solana/kit` 6.10
  at runtime. `@solana/mpp` 0.11 already depends on it the same way.
- The Squads SDK's `rpc.*` helpers do not wait for confirmation. Tabula builds with `squads.instructions.*`,
  converts the web3.js instructions to kit instructions, and confirms each step itself
  (`packages/solana/src/squads.ts`).

## Squads v4

- Program `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` on the sandbox and devnet. SDK `@sqds/multisig@2.1.4`
  (2025-08-15). The vault is a PDA, so any vault-signed instruction (e.g. creating delegations) goes through a
  vault transaction: create → propose → approve → execute (threshold 1 in the demo).

## pay CLI remote signing backends (stretch goal)

- `pay` `rust/crates/core/src/remote/mod.rs`: implement the `RemoteProvider` trait in `remote/<name>.rs` and add
  it to the `PROVIDERS` registry. `openfort.rs` is the reference: a `solana-keychain` `TransactionSigner` that
  signs over HTTPS, where every signature is a policy-checked API call. A Tabula provider would follow the
  same shape.

## Reflect USDC+ (nice-to-have)

- `docs.reflect.money/llms.txt` lists mint/burn transaction generation endpoints and a TS SDK
  (`@reflectmoney/stable.ts@5.3.2`). **No devnet or testnet availability statement was found** (checked 2026-10-04).
- Treat it as mainnet-only, behind an interface, labelled "mainnet only" in the UI.
- Unverified idea: because the sandbox clones mainnet, Reflect's mainnet program may be callable there.
  Spike before relying on it.

## Divergences from PROMPT.md

- Next.js latest is 16.x, not 15. The App Router API is the same, and Tabula uses 16.
- `@solana/mpp` on npm lags the repo (0.7.0 vs 0.11.0). See the SDK section for how Tabula handles it.
- The devnet program's treasury is not the value in upstream `constants.rs`. The deployed binary wins.
