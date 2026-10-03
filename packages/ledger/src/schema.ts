/**
 * Ledger schema. SQLite for the demo (node:sqlite via drizzle's sqlite-proxy driver, no native deps);
 * the shapes are plain enough to port to Postgres. Amounts are integer micro-dollars (USDC base
 * units). Timestamps are epoch milliseconds.
 */
import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const agents = sqliteTable('agents', {
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
  allowanceAmount: integer('allowance_amount'),
  dailyBudget: integer('daily_budget').notNull(),
  status: text('status', { enum: ['active', 'paused', 'killed'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at').notNull(),
})

export const vendors = sqliteTable('vendors', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  endpoint: text('endpoint').notNull(),
  payeePubkey: text('payee_pubkey').notNull(),
  mint: text('mint').notNull(),
  programId: text('program_id').notNull(),
  unitName: text('unit_name').notNull(),
  /** Registered price per unit; a 402 challenge offering more is rejected. */
  unitPrice: integer('unit_price').notNull(),
  maxUnitPrice: integer('max_unit_price').notNull(),
  taskType: text('task_type').notNull(),
  allowlisted: integer('allowlisted', { mode: 'boolean' }).notNull().default(true),
})

export const policies = sqliteTable(
  'policies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scope: text('scope', { enum: ['global', 'agent', 'vendor'] }).notNull(),
    scopeId: text('scope_id'),
    rulesJson: text('rules_json').notNull(),
    version: integer('version').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    updatedBy: text('updated_by').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('policies_scope_idx').on(t.scope, t.scopeId, t.active)],
)

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  label: text('label').notNull(),
  customerTag: text('customer_tag'),
  taskType: text('task_type').notNull(),
  budget: integer('budget'),
  status: text('status', { enum: ['running', 'completed', 'failed'] })
    .notNull()
    .default('running'),
  createdAt: integer('created_at').notNull(),
  completedAt: integer('completed_at'),
})

export const channels = sqliteTable(
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
    pricePerCall: integer('price_per_call').notNull(),
    payerPubkey: text('payer_pubkey').notNull(),
    authorizedSigner: text('authorized_signer').notNull(),
    deposit: integer('deposit').notNull(),
    signedCumulative: integer('signed_cumulative').notNull().default(0),
    settledAmount: integer('settled_amount'),
    refundedAmount: integer('refunded_amount'),
    status: text('status', {
      enum: ['opening', 'open', 'closing', 'sealed', 'refunded', 'failed'],
    })
      .notNull()
      .default('opening'),
    closeReason: text('close_reason'),
    openTx: text('open_tx'),
    closeTx: text('close_tx'),
    refundTx: text('refund_tx'),
    gracePeriod: integer('grace_period'),
    openedAt: integer('opened_at').notNull(),
    lastVoucherAt: integer('last_voucher_at'),
    closedAt: integer('closed_at'),
  },
  (t) => [index('channels_agent_idx').on(t.agentId), index('channels_status_idx').on(t.status)],
)

export const vouchers = sqliteTable(
  'vouchers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** session id + cumulative amount: retries of the same voucher collapse to one row. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** Optional agent-supplied request id; a retried request returns the original result. */
    requestId: text('request_id'),
    channelId: text('channel_id').notNull(),
    agentId: text('agent_id').notNull(),
    taskId: text('task_id').notNull(),
    vendorId: text('vendor_id').notNull(),
    cumulativeAmount: integer('cumulative_amount').notNull(),
    delta: integer('delta').notNull(),
    unitCount: integer('unit_count').notNull(),
    unitPrice: integer('unit_price').notNull(),
    verdict: text('verdict', { enum: ['signed', 'blocked'] }).notNull(),
    ruleTriggered: text('rule_triggered'),
    reason: text('reason'),
    /** base58 Ed25519 signature over the 50-byte voucher; null when blocked. */
    signature: text('signature'),
    responseStatus: text('response_status', { enum: ['ok', 'error', 'timeout', 'empty'] }),
    latencyMs: integer('latency_ms'),
    ts: integer('ts').notNull(),
    batchId: integer('batch_id'),
  },
  (t) => [
    uniqueIndex('vouchers_idem_idx').on(t.idempotencyKey),
    uniqueIndex('vouchers_request_idx').on(t.channelId, t.requestId),
    index('vouchers_agent_ts_idx').on(t.agentId, t.ts),
    index('vouchers_channel_idx').on(t.channelId),
    index('vouchers_batch_idx').on(t.batchId),
  ],
)

export const challengeChecks = sqliteTable('challenge_checks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentId: text('agent_id').notNull(),
  vendorId: text('vendor_id'),
  endpoint: text('endpoint').notNull(),
  payeeExpected: text('payee_expected'),
  payeeOffered: text('payee_offered'),
  mintExpected: text('mint_expected'),
  mintOffered: text('mint_offered'),
  programId: text('program_id'),
  priceOffered: integer('price_offered'),
  simulationOk: integer('simulation_ok', { mode: 'boolean' }),
  verdict: text('verdict').notNull(),
  reason: text('reason').notNull(),
  ts: integer('ts').notNull(),
})

export const batches = sqliteTable('batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  merkleRoot: text('merkle_root').notNull(),
  voucherCount: integer('voucher_count').notNull(),
  firstVoucherId: integer('first_voucher_id').notNull(),
  lastVoucherId: integer('last_voucher_id').notNull(),
  status: text('status', { enum: ['pending', 'anchored', 'failed'] })
    .notNull()
    .default('pending'),
  txSignature: text('tx_signature'),
  createdAt: integer('created_at').notNull(),
  anchoredAt: integer('anchored_at'),
})

/** Append-only audit log: policy changes, kills, opens, closes, refunds, sweeps, anchors. */
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    type: text('type').notNull(),
    agentId: text('agent_id'),
    channelId: text('channel_id'),
    message: text('message').notNull(),
    dataJson: text('data_json').notNull().default(sql`'{}'`),
    txSignature: text('tx_signature'),
  },
  (t) => [index('events_ts_idx').on(t.ts)],
)

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
