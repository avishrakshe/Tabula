/**
 * Ledger schema (Postgres): Supabase when deployed, embedded PGlite locally and in tests. Amounts are
 * integer micro-dollars (USDC base units) and timestamps are epoch milliseconds, both as `bigint` columns
 * read back as JS numbers (exact up to 2^53: about $9 billion, and the year 287,396).
 */
import { sql } from 'drizzle-orm'
import { bigint, boolean, index, pgTable, primaryKey, serial, text, uniqueIndex } from 'drizzle-orm/pg-core'

const money = (name: string) => bigint(name, { mode: 'number' })
const millis = (name: string) => bigint(name, { mode: 'number' })

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  department: text('department').notNull(),
  /** sha256 of the agent's gateway API key; the key itself is shown once and never stored. */
  apiKeyHash: text('api_key_hash').notNull(),
  /** Agent funding wallet. Tabula holds this key; the agent process never sees it. */
  payerPubkey: text('payer_pubkey').notNull(),
  /** Channel `authorized_signer` for this agent's channels. Tabula holds this key too. */
  voucherPubkey: text('voucher_pubkey').notNull(),
  /** Onchain allowance (Subscriptions-program delegation PDA) that caps what the payer can pull. */
  allowancePubkey: text('allowance_pubkey'),
  allowanceAmount: money('allowance_amount'),
  dailyBudget: money('daily_budget').notNull(),
  status: text('status', { enum: ['active', 'paused', 'killed'] })
    .notNull()
    .default('active'),
  createdAt: millis('created_at').notNull(),
})

export const vendors = pgTable('vendors', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  endpoint: text('endpoint').notNull(),
  payeePubkey: text('payee_pubkey').notNull(),
  mint: text('mint').notNull(),
  programId: text('program_id').notNull(),
  unitName: text('unit_name').notNull(),
  /** Registered price per unit; a 402 challenge offering more is rejected. */
  unitPrice: money('unit_price').notNull(),
  maxUnitPrice: money('max_unit_price').notNull(),
  taskType: text('task_type').notNull(),
  allowlisted: boolean('allowlisted').notNull().default(true),
})

export const policies = pgTable(
  'policies',
  {
    id: serial('id').primaryKey(),
    scope: text('scope', { enum: ['global', 'agent', 'vendor'] }).notNull(),
    scopeId: text('scope_id'),
    rulesJson: text('rules_json').notNull(),
    version: bigint('version', { mode: 'number' }).notNull(),
    active: boolean('active').notNull().default(true),
    updatedBy: text('updated_by').notNull(),
    updatedAt: millis('updated_at').notNull(),
  },
  (t) => [index('policies_scope_idx').on(t.scope, t.scopeId, t.active)],
)

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  label: text('label').notNull(),
  customerTag: text('customer_tag'),
  taskType: text('task_type').notNull(),
  budget: money('budget'),
  status: text('status', { enum: ['running', 'completed', 'failed'] })
    .notNull()
    .default('running'),
  createdAt: millis('created_at').notNull(),
  completedAt: millis('completed_at'),
})

export const channels = pgTable(
  'channels',
  {
    /** Gateway session id. */
    id: text('id').primaryKey(),
    channelPda: text('channel_pda'),
    agentId: text('agent_id').notNull(),
    vendorId: text('vendor_id').notNull(),
    taskId: text('task_id'),
    /** Endpoint the session pays (registry default, or an override the agent asked for). */
    endpoint: text('endpoint').notNull(),
    /** Amount per call from the verified 402 challenge. */
    pricePerCall: money('price_per_call').notNull(),
    payerPubkey: text('payer_pubkey').notNull(),
    authorizedSigner: text('authorized_signer').notNull(),
    deposit: money('deposit').notNull(),
    signedCumulative: money('signed_cumulative').notNull().default(0),
    settledAmount: money('settled_amount'),
    refundedAmount: money('refunded_amount'),
    status: text('status', {
      enum: ['opening', 'open', 'closing', 'sealed', 'refunded', 'failed'],
    })
      .notNull()
      .default('opening'),
    closeReason: text('close_reason'),
    openTx: text('open_tx'),
    closeTx: text('close_tx'),
    refundTx: text('refund_tx'),
    gracePeriod: bigint('grace_period', { mode: 'number' }),
    openedAt: millis('opened_at').notNull(),
    lastVoucherAt: millis('last_voucher_at'),
    /** When a gateway instance claimed the close; a close stalled past a threshold is resumed by cron. */
    closingAt: millis('closing_at'),
    closedAt: millis('closed_at'),
  },
  (t) => [index('channels_agent_idx').on(t.agentId), index('channels_status_idx').on(t.status)],
)

export const vouchers = pgTable(
  'vouchers',
  {
    id: serial('id').primaryKey(),
    /** session id + cumulative amount: retries of the same voucher collapse to one row. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** Optional agent-supplied request id; a retried request returns the original result. */
    requestId: text('request_id'),
    channelId: text('channel_id').notNull(),
    agentId: text('agent_id').notNull(),
    taskId: text('task_id').notNull(),
    vendorId: text('vendor_id').notNull(),
    cumulativeAmount: money('cumulative_amount').notNull(),
    delta: money('delta').notNull(),
    unitCount: bigint('unit_count', { mode: 'number' }).notNull(),
    unitPrice: money('unit_price').notNull(),
    verdict: text('verdict', { enum: ['signed', 'blocked'] }).notNull(),
    ruleTriggered: text('rule_triggered'),
    reason: text('reason'),
    /** base58 Ed25519 signature over the 50-byte voucher; null when blocked. */
    signature: text('signature'),
    responseStatus: text('response_status', { enum: ['ok', 'error', 'timeout', 'empty'] }),
    latencyMs: bigint('latency_ms', { mode: 'number' }),
    ts: millis('ts').notNull(),
    batchId: bigint('batch_id', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('vouchers_idem_idx').on(t.idempotencyKey),
    uniqueIndex('vouchers_request_idx').on(t.channelId, t.requestId),
    index('vouchers_agent_ts_idx').on(t.agentId, t.ts),
    index('vouchers_channel_idx').on(t.channelId),
    index('vouchers_batch_idx').on(t.batchId),
  ],
)

export const challengeChecks = pgTable('challenge_checks', {
  id: serial('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  vendorId: text('vendor_id'),
  endpoint: text('endpoint').notNull(),
  payeeExpected: text('payee_expected'),
  payeeOffered: text('payee_offered'),
  mintExpected: text('mint_expected'),
  mintOffered: text('mint_offered'),
  programId: text('program_id'),
  priceOffered: money('price_offered'),
  simulationOk: boolean('simulation_ok'),
  verdict: text('verdict').notNull(),
  reason: text('reason').notNull(),
  ts: millis('ts').notNull(),
})

export const batches = pgTable('batches', {
  id: serial('id').primaryKey(),
  merkleRoot: text('merkle_root').notNull(),
  voucherCount: bigint('voucher_count', { mode: 'number' }).notNull(),
  firstVoucherId: bigint('first_voucher_id', { mode: 'number' }).notNull(),
  lastVoucherId: bigint('last_voucher_id', { mode: 'number' }).notNull(),
  status: text('status', { enum: ['pending', 'anchored', 'failed'] })
    .notNull()
    .default('pending'),
  txSignature: text('tx_signature'),
  createdAt: millis('created_at').notNull(),
  anchoredAt: millis('anchored_at'),
})

/** Append-only audit log: policy changes, kills, opens, closes, refunds, sweeps, anchors. */
export const events = pgTable(
  'events',
  {
    id: serial('id').primaryKey(),
    ts: millis('ts').notNull(),
    type: text('type').notNull(),
    agentId: text('agent_id'),
    channelId: text('channel_id'),
    message: text('message').notNull(),
    dataJson: text('data_json').notNull().default(sql`'{}'`),
    txSignature: text('tx_signature'),
  },
  (t) => [index('events_ts_idx').on(t.ts)],
)

/**
 * The hosted demo vendors' MPP session state (their `SessionStore`), one JSON record per channel. Real
 * vendors keep their own; ours share Tabula's database only because they are deployed with it.
 */
export const vendorSessions = pgTable(
  'vendor_sessions',
  {
    vendorId: text('vendor_id').notNull(),
    channelId: text('channel_id').notNull(),
    stateJson: text('state_json').notNull(),
    updatedAt: millis('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.vendorId, t.channelId] })],
)

/** Non-secret deployment state (e.g. the treasury setup: vault, mint, allowances), as JSON values. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: millis('updated_at').notNull(),
})

export type AgentRow = typeof agents.$inferSelect
export type VendorRow = typeof vendors.$inferSelect
export type PolicyRow = typeof policies.$inferSelect
export type TaskRow = typeof tasks.$inferSelect
export type ChannelRow = typeof channels.$inferSelect
export type VoucherRow = typeof vouchers.$inferSelect
export type NewVoucherRow = typeof vouchers.$inferInsert
export type ChallengeCheckRow = typeof challengeChecks.$inferSelect
export type BatchRow = typeof batches.$inferSelect
export type EventRow = typeof events.$inferSelect
