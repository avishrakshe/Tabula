import { type LedgerDb, schema, withLock } from '@tabula/ledger'
import { and, desc, eq, gte } from '@tabula/ledger/sql'
import {
  type AgentStatus,
  compilePolicy,
  type Decision,
  EMPTY_POLICY,
  evaluate,
  mergePolicies,
  type Policy,
  type PolicyDoc,
  pruneHistory,
  type SpendEvent,
} from '@tabula/policy'
import { type Approval, issueApproval } from './custody'
import type { EventBus } from './events'

export interface AuthorizeInput {
  readonly agentId: string
  readonly sessionId: string
  readonly channelId: string
  readonly vendorId: string
  readonly taskId: string
  readonly units: number
  readonly unitPrice: bigint
  readonly deposit: bigint
  readonly signedCumulative: bigint
  readonly ceiling: bigint | null
  readonly now?: number
}

/** The global kill switch is on when the latest global_kill event is newer than the latest global_unkill. */
async function readGlobalKill(db: LedgerDb): Promise<boolean> {
  const latest = async (type: 'global_kill' | 'global_unkill') =>
    (
      await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.type, type))
        .orderBy(desc(schema.events.id))
        .limit(1)
    )[0]?.id ?? 0
  const [kill, unkill] = [await latest('global_kill'), await latest('global_unkill')]
  return kill > unkill
}

interface PolicyVersion {
  readonly id: number
  readonly version: number
  readonly doc: PolicyDoc
  readonly compiled: Policy
}

/**
 * Owns everything `evaluate` needs: active policy versions per scope, each agent's recent signed
 * spend (rebuilt from the ledger at boot, so a restart loses nothing), agent status and the global
 * kill switch. `authorize` is the only place approvals for the voucher signer are minted.
 */
export class PolicyService {
  readonly #history = new Map<string, SpendEvent[]>()
  readonly #status = new Map<string, AgentStatus>()
  #global: PolicyVersion | null = null
  readonly #agentPolicies = new Map<string, PolicyVersion>()
  readonly #vendorPolicies = new Map<string, PolicyVersion>()
  #globalKill = false

  constructor(
    private readonly db: LedgerDb,
    private readonly bus: EventBus,
  ) {}

  async load(now = Date.now()): Promise<void> {
    const policies = await this.db.select().from(schema.policies).where(eq(schema.policies.active, true))
    this.#global = null
    this.#agentPolicies.clear()
    this.#vendorPolicies.clear()
    for (const p of policies) this.#install(p)
    const agents = await this.db.select().from(schema.agents)
    for (const a of agents) this.#status.set(a.id, a.status)
    // replay the last 48h of signed vouchers into the in-memory history
    const since = now - 2 * 86_400_000
    const rows = await this.db
      .select()
      .from(schema.vouchers)
      .where(and(eq(schema.vouchers.verdict, 'signed'), gte(schema.vouchers.ts, since)))
    this.#history.clear()
    for (const r of rows) {
      const h = this.#history.get(r.agentId) ?? []
      h.push({ ts: r.ts, amount: BigInt(r.delta), taskId: r.taskId, vendorId: r.vendorId })
      this.#history.set(r.agentId, h)
    }
    this.#globalKill = await readGlobalKill(this.db)
  }

  /**
   * Reloads everything one agent's next decision depends on (active policies, its status, the global
   * kill switch, its last 48h of signed spend), inside the caller's transaction. With several gateway
   * instances sharing one database, any of them may have written since this one last looked.
   */
  async refreshAgent(tx: LedgerDb, agentId: string, now = Date.now()): Promise<void> {
    const policies = await tx.select().from(schema.policies).where(eq(schema.policies.active, true))
    this.#global = null
    this.#agentPolicies.clear()
    this.#vendorPolicies.clear()
    for (const p of policies) this.#install(p)
    const [agent] = await tx
      .select({ status: schema.agents.status })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
    if (agent) this.#status.set(agentId, agent.status)
    const rows = await tx
      .select({
        ts: schema.vouchers.ts,
        delta: schema.vouchers.delta,
        taskId: schema.vouchers.taskId,
        vendorId: schema.vouchers.vendorId,
      })
      .from(schema.vouchers)
      .where(
        and(
          eq(schema.vouchers.agentId, agentId),
          eq(schema.vouchers.verdict, 'signed'),
          gte(schema.vouchers.ts, now - 2 * 86_400_000),
        ),
      )
    this.#history.set(
      agentId,
      rows.map((r) => ({ ts: r.ts, amount: BigInt(r.delta), taskId: r.taskId, vendorId: r.vendorId })),
    )
    this.#globalKill = await readGlobalKill(tx)
  }

  #install(p: schema.PolicyRow): void {
    const doc = JSON.parse(p.rulesJson) as PolicyDoc
    const v: PolicyVersion = { id: p.id, version: p.version, doc, compiled: compilePolicy(doc) }
    if (p.scope === 'global') this.#global = v
    else if (p.scope === 'agent' && p.scopeId) this.#agentPolicies.set(p.scopeId, v)
    else if (p.scope === 'vendor' && p.scopeId) this.#vendorPolicies.set(p.scopeId, v)
  }

  effectivePolicy(agentId: string, vendorId?: string): Policy {
    const parts: Policy[] = []
    if (this.#global) parts.push(this.#global.compiled)
    const a = this.#agentPolicies.get(agentId)
    if (a) parts.push(a.compiled)
    const v = vendorId ? this.#vendorPolicies.get(vendorId) : undefined
    if (v) parts.push(v.compiled)
    return parts.length ? mergePolicies(...parts) : EMPTY_POLICY
  }

  policyDoc(
    scope: 'global' | 'agent' | 'vendor',
    scopeId?: string,
  ): { doc: PolicyDoc; version: number } | null {
    const v =
      scope === 'global'
        ? this.#global
        : scope === 'agent'
          ? this.#agentPolicies.get(scopeId ?? '')
          : this.#vendorPolicies.get(scopeId ?? '')
    return v ? { doc: v.doc, version: v.version } : null
  }

  /** Writes a new version (old one deactivated) and records an audit event. Throws on invalid policy. */
  async setPolicy(
    scope: 'global' | 'agent' | 'vendor',
    scopeId: string | null,
    doc: PolicyDoc,
    updatedBy: string,
  ): Promise<number> {
    compilePolicy(doc) // validate before touching the DB
    const now = Date.now()
    const scopeFilter = scopeId
      ? and(eq(schema.policies.scope, scope), eq(schema.policies.scopeId, scopeId))
      : eq(schema.policies.scope, scope)
    // number the version from the ledger, under a lock: another instance may have saved one since
    const { row, version, current } = await withLock(
      this.db,
      `policy:${scope}:${scopeId ?? ''}`,
      async (tx) => {
        const [latest] = await tx
          .select()
          .from(schema.policies)
          .where(scopeFilter)
          .orderBy(desc(schema.policies.version))
          .limit(1)
        const version = (latest?.version ?? 0) + 1
        await tx.update(schema.policies).set({ active: false }).where(scopeFilter)
        const [row] = await tx
          .insert(schema.policies)
          .values({
            scope,
            scopeId,
            rulesJson: JSON.stringify(doc),
            version,
            active: true,
            updatedBy,
            updatedAt: now,
          })
          .returning()
        const current = latest?.active ? { doc: JSON.parse(latest.rulesJson) as PolicyDoc } : null
        return { row, version, current }
      },
    )
    if (row) this.#install(row)
    await this.bus.emit({
      type: 'policy_changed',
      agentId: scope === 'agent' ? scopeId : null,
      message: `${updatedBy} updated the ${scope}${scopeId ? ` ${scopeId}` : ''} policy to v${version}`,
      data: { scope, scopeId, version, before: current?.doc ?? null, after: doc },
    })
    return version
  }

  history(agentId: string): readonly SpendEvent[] {
    return this.#history.get(agentId) ?? []
  }

  get globalKill(): boolean {
    return this.#globalKill
  }

  setGlobalKill(on: boolean): void {
    this.#globalKill = on
  }

  agentStatus(agentId: string): AgentStatus {
    return this.#status.get(agentId) ?? 'active'
  }

  setAgentStatus(agentId: string, status: AgentStatus): void {
    this.#status.set(agentId, status)
  }

  authorize(input: AuthorizeInput): { decision: Decision; approval: Approval | null } {
    const now = input.now ?? Date.now()
    const policy = this.effectivePolicy(input.agentId, input.vendorId)
    const decision = evaluate(
      {
        now,
        globalKill: this.#globalKill,
        agentStatus: this.agentStatus(input.agentId),
        history: this.history(input.agentId),
        channel: { deposit: input.deposit, signedCumulative: input.signedCumulative },
        ceiling: input.ceiling,
      },
      {
        agentId: input.agentId,
        taskId: input.taskId,
        vendorId: input.vendorId,
        units: input.units,
        unitPrice: input.unitPrice,
      },
      policy,
    )
    if (decision.verdict !== 'allow') return { decision, approval: null }
    return {
      decision,
      approval: issueApproval({
        agentId: input.agentId,
        sessionId: input.sessionId,
        channelId: input.channelId,
        cumulative: decision.newCumulative,
      }),
    }
  }

  recordSigned(agentId: string, event: SpendEvent): void {
    const policy = this.effectivePolicy(agentId)
    const next = pruneHistory([...this.history(agentId), event], event.ts, policy)
    this.#history.set(agentId, next)
  }
}
