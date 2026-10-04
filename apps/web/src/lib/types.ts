/** Shapes of the gateway's admin API (apps/gateway/src/app.ts). Amounts are integer micro-dollars. */

export interface Overview {
  spendToday: number
  spendThisHour: number
  vouchersToday: number
  blockedToday: number
  activeAgents: number
  totalAgents: number
  escrowTiedUp: number
  openChannels: number
  escrowReclaimedThisWeek: number
  sweptToVaultThisWeek: number
  cluster: string
  treasury: string
  vault: string | null
  vaultBalance: string | null
}

export interface Agent {
  id: string
  name: string
  role: string
  department: string
  payerPubkey: string
  voucherPubkey: string
  allowancePubkey: string | null
  dailyBudget: number
  status: 'active' | 'paused' | 'killed'
  createdAt: number
  allowance: { address: string; perPeriod: string; remaining: string; periodS: string } | null
}

export interface Vendor {
  id: string
  name: string
  endpoint: string
  payeePubkey: string
  mint: string
  programId: string
  unitName: string
  unitPrice: number
  maxUnitPrice: number
  taskType: string
  allowlisted: boolean
}

export interface VoucherRow {
  id: number
  channelId: string
  agentId: string
  taskId: string
  vendorId: string
  cumulativeAmount: number
  delta: number
  unitCount: number
  unitPrice: number
  verdict: 'signed' | 'blocked'
  ruleTriggered: string | null
  reason: string | null
  signature: string | null
  responseStatus: 'ok' | 'error' | 'timeout' | 'empty' | null
  latencyMs: number | null
  ts: number
  batchId: number | null
}

export interface ChannelRow {
  id: string
  channelPda: string | null
  agentId: string
  vendorId: string
  taskId: string | null
  endpoint: string
  pricePerCall: number
  payerPubkey: string
  authorizedSigner: string
  deposit: number
  signedCumulative: number
  settledAmount: number | null
  refundedAmount: number | null
  status: 'opening' | 'open' | 'closing' | 'sealed' | 'refunded' | 'failed'
  closeReason: string | null
  openTx: string | null
  closeTx: string | null
  gracePeriod: number | null
  openedAt: number
  lastVoucherAt: number | null
  closedAt: number | null
}

export interface FloatView {
  treasury: { kind: string; vault: string | null; balance: string | null }
  escrowTiedUp: string
  channels: {
    sessionId: string
    agentId: string
    vendorId: string
    channel: string
    deposit: string
    used: string
    idleEscrow: string
    idleMs: number
    explorerUrl: string
  }[]
  byVendor: { vendorId: string; channels: number; deposit: string; used: string; idleEscrow: string }[]
}

export interface VendorScore {
  vendorId: string
  taskType: string
  spend: number
  wasted: number
  wastePct: number
  paidCalls: number
  failedCalls: number
  completedTasks: number
  costPerCompletedTask: number | null
  p95LatencyMs: number | null
  cheaperOption: { vendorId: string; costPerCompletedTask: number; savingsPct: number } | null
}

export type ReconcileStatus = 'MATCHED' | 'LEDGER_AHEAD' | 'CHAIN_AHEAD' | 'REFUND_PENDING'

export interface ReconcileRow {
  sessionId: string
  agentId: string
  vendorId: string
  channel: string | null
  deposit: string
  ledgerSigned: string
  settled: string
  refundDue: string
  refunded: boolean
  status: ReconcileStatus
  explanation: string
  source: 'onchain' | 'recorded-at-close'
  closedAt: number | null
  closeTx: string | null
  explorerUrl: string | null
}

export interface Batch {
  id: number
  merkleRoot: string
  voucherCount: number
  firstVoucherId: number
  lastVoucherId: number
  status: 'pending' | 'anchored' | 'failed'
  txSignature: string | null
  createdAt: number
  anchoredAt: number | null
}

export interface BatchVerification {
  batchId: number
  voucherCount: number
  storedRoot: string
  recomputedRoot: string
  onchainRoot: string | null
  txSignature: string | null
  explorerUrl: string | null
  match: boolean
  reason: string
}

export interface ChallengeCheck {
  id: number
  agentId: string
  vendorId: string | null
  endpoint: string
  payeeExpected: string | null
  payeeOffered: string | null
  mintExpected: string | null
  mintOffered: string | null
  programId: string | null
  priceOffered: number | null
  simulationOk: boolean | null
  verdict: string
  reason: string
  ts: number
}

export interface PolicyRow {
  id: number
  scope: 'global' | 'agent' | 'vendor'
  scopeId: string | null
  rules: Record<string, unknown>
  version: number
  active: boolean
  updatedBy: string
  updatedAt: number
}

/** Audit-log rows (/v1/events) and live stream events, normalized for timelines. */
export interface TimelineItem {
  key: string
  ts: number
  type: string
  agentId: string | null
  channelId: string | null
  message: string
  txSignature: string | null
  explorerUrl: string | null
  data: Record<string, unknown>
}

export interface DashboardData {
  overview: Overview | null
  agents: Agent[]
  vendors: Vendor[]
  channels: ChannelRow[]
  float: FloatView | null
  scores: VendorScore[]
  reconcile: ReconcileRow[]
  batches: Batch[]
  challenges: ChallengeCheck[]
  policies: PolicyRow[]
  /** Newest first. */
  vouchers: VoucherRow[]
  /** Newest first. */
  timeline: TimelineItem[]
}

export const EMPTY_DATA: DashboardData = {
  overview: null,
  agents: [],
  vendors: [],
  channels: [],
  float: null,
  scores: [],
  reconcile: [],
  batches: [],
  challenges: [],
  policies: [],
  vouchers: [],
  timeline: [],
}
