/**
 * The hosted live demo: the same story as `pnpm demo`, run as short ticks so no function call is long.
 * Any viewer's browser (or cron) advances the one active run by calling `tick`. A tick claims a lease
 * on the run row, does what is due for at most ~15 seconds, and saves its state.
 *
 *   t=0     research-01, coder-01 and rogue-01 open channels (one open per tick) and pay per call
 *   t=20s   coder-01 follows a poisoned link to a "faster mirror": its 402 names another payee and is
 *           refused before anything is signed; coder-01 falls back to the registered inference-a
 *   t=35s   rogue-01 reads a prompt-injected ticket and calls as fast as it can, until the velocity
 *           rule refuses a voucher, stops it and closes its channel
 *   t=75s   the float manager closes the channel coder-01 abandoned
 *   t=95s   close-out: channels closed, float swept to the vault, the ledger anchored onchain
 */
import { CODING_PROMPTS, RESEARCH_PROMPTS, TICKET_PROMPTS } from '@tabula/agents'
import { type Gateway, GatewayError } from '@tabula/gateway'
import { first, type LedgerDb, schema, withLock } from '@tabula/ledger'
import { and, desc, eq, isNull, lt, or, sql } from '@tabula/ledger/sql'
import { createRpc, loadOrCreateKeypair, ownerTokenBalance, solBalance } from '@tabula/solana'

interface AgentState {
  readonly id: string
  vendorId: string
  sessionId: string | null
  /** Pause between paid calls; 0 = as fast as a tick allows (the injected rogue). */
  intervalMs: number
  /** Run-relative ms of the last call. */
  lastCallAt: number
  task: number
  taskCalls: number
  taskOk: number
  openFailures: number
  stopped: boolean
  note: string | null
  /** Escrow for this agent's channels (micro-dollars): small, so the onchain allowances last many runs. */
  readonly deposit: string
}

interface RunState {
  readonly vendorBase: string
  readonly agents: AgentState[]
  readonly done: string[]
}

export interface RunView {
  readonly id: number
  readonly status: 'running' | 'done' | 'failed'
  readonly startedAt: number
  readonly elapsedMs: number
  readonly finishedAt: number | null
  readonly steps: readonly string[]
  readonly agents: readonly { id: string; vendorId: string; stopped: boolean; note: string | null }[]
  readonly error: string | null
}

export class DemoUnavailable extends Error {
  constructor(
    readonly reason: 'busy' | 'rate-limited' | 'refueling',
    message: string,
  ) {
    super(message)
  }
}

const TICK_BUDGET_MS = 15_000
/** A tick may wait on a cooperative close or a few confirmations; another instance waits this long before taking over. */
const LEASE_MS = 110_000
/** A run nobody has advanced for this long is abandoned (cron fails it; a new visitor may start another). */
const STALE_MS = 4 * 60_000
const CALLS_PER_TASK = 6
const MAX_CALLS_PER_TASK = 12
const PROMPTS: Record<string, readonly string[]> = {
  'research-01': RESEARCH_PROMPTS,
  'coder-01': CODING_PROMPTS,
  'rogue-01': TICKET_PROMPTS,
}
const STEPS = [
  { id: 'mirror', at: 20_000 },
  { id: 'inject', at: 35_000 },
  { id: 'sweep', at: 75_000 },
  { id: 'finish', at: 95_000 },
] as const

function initialState(vendorBase: string): RunState {
  const agent = (id: string, vendorId: string, intervalMs: number, deposit: number): AgentState => ({
    id,
    vendorId,
    sessionId: null,
    intervalMs,
    lastCallAt: 0,
    task: 1,
    taskCalls: 0,
    taskOk: 0,
    openFailures: 0,
    stopped: false,
    note: null,
    deposit: String(deposit),
  })
  return {
    vendorBase,
    agents: [
      agent('research-01', 'inference-a', 1_500, 120_000),
      agent('coder-01', 'inference-b', 800, 150_000),
      agent('rogue-01', 'inference-b', 2_500, 150_000),
    ],
    done: [],
  }
}

const view = (row: typeof schema.demoRuns.$inferSelect, now = Date.now()): RunView => {
  const state = JSON.parse(row.stateJson) as RunState
  return {
    id: row.id,
    status: row.status,
    startedAt: row.startedAt,
    elapsedMs: (row.finishedAt ?? now) - row.startedAt,
    finishedAt: row.finishedAt,
    steps: state.done,
    agents: state.agents.map((a) => ({ id: a.id, vendorId: a.vendorId, stopped: a.stopped, note: a.note })),
    error: row.error,
  }
}

/** Fixed-window counter: true while `key` has been hit at most `limit` times in the current window. */
async function allow(db: LedgerDb, key: string, limit: number, windowMs: number, now = Date.now()) {
  const [row] = await db
    .insert(schema.rateLimits)
    .values({ key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: schema.rateLimits.key,
      set: {
        count: sql`case when ${schema.rateLimits.windowStart} < ${now - windowMs} then 1 else ${schema.rateLimits.count} + 1 end`,
        windowStart: sql`case when ${schema.rateLimits.windowStart} < ${now - windowMs} then ${now} else ${schema.rateLimits.windowStart} end`,
      },
    })
    .returning({ count: schema.rateLimits.count })
  return (row?.count ?? 0) <= limit
}

/**
 * The devnet funds watchdog: enough SOL for fees and rent, enough test USDC in the vault, and enough
 * left on every agent's onchain allowance for one run. Null when a run can start, else the reason.
 */
export async function fundsProblem(gw: Gateway): Promise<string | null> {
  const { cluster } = gw.config
  if (!cluster.cheatcodes) {
    const rpc = createRpc(cluster.rpcUrl)
    const needs: [string, bigint][] = [
      ['tabula-operator', 100_000_000n],
      ['vendor-inference-a-operator', 20_000_000n],
      ['vendor-inference-b-operator', 20_000_000n],
      ['vendor-mirror-operator', 5_000_000n],
      ['vendor-inference-a-payee', 2_000_000n],
      ['vendor-inference-b-payee', 2_000_000n],
    ]
    for (const [name, min] of needs) {
      const k = await loadOrCreateKeypair(name)
      if ((await solBalance(rpc, k.address)) < min) return `${name} is low on devnet SOL`
    }
    const vault = gw.treasury.vaultAddress
    if (vault && (await ownerTokenBalance(rpc, vault as never, gw.config.mint as never)) < 2_000_000n)
      return 'the treasury vault is low on test USDC'
  }
  const need = { 'research-01': 120_000n, 'coder-01': 300_000n, 'rogue-01': 150_000n } as const
  for (const [agentId, amount] of Object.entries(need)) {
    const ceiling = await gw.treasury.remainingCeiling(agentId)
    if (ceiling !== null && ceiling < amount) return `${agentId}'s onchain allowance is spent for today`
  }
  return null
}

/** The active run, if any (null when none, or when the latest one has gone stale). */
export async function activeRun(db: LedgerDb, now = Date.now()) {
  const row = await first(db.select().from(schema.demoRuns).orderBy(desc(schema.demoRuns.id)).limit(1))
  return row && row.status === 'running' && now - row.updatedAt < STALE_MS ? row : null
}

export async function latestRun(db: LedgerDb): Promise<RunView | null> {
  const row = await first(db.select().from(schema.demoRuns).orderBy(desc(schema.demoRuns.id)).limit(1))
  return row ? view(row) : null
}

/**
 * Starts a live run, or joins the one already running. Rate-limited per requester and per day, and
 * refused while the devnet wallets need refuelling (the dashboard then shows the recorded run).
 */
export async function startRun(
  gw: Gateway,
  opts: { requester: string; vendorBase: string },
): Promise<{ run: RunView; joined: boolean }> {
  const db = gw.ledger.db
  const now = Date.now()
  const running = await activeRun(db, now)
  if (running) return { run: view(running, now), joined: true }
  const problem = await fundsProblem(gw)
  if (problem)
    throw new DemoUnavailable(
      'refueling',
      `Live demo is refuelling (${problem}); showing the latest recorded run.`,
    )
  return withLock(db, 'demo:start', async (tx) => {
    const again = await activeRun(tx, now)
    if (again) return { run: view(again, now), joined: true }
    if (!(await allow(tx, `demo:ip:${opts.requester}`, 4, 3_600_000, now)))
      throw new DemoUnavailable(
        'rate-limited',
        'You have started a few runs this hour; showing the latest recorded run.',
      )
    if (!(await allow(tx, 'demo:day', 40, 86_400_000, now)))
      throw new DemoUnavailable(
        'rate-limited',
        'The live demo has run plenty today; showing the latest recorded run.',
      )
    // anything left running is stale by now
    await tx
      .update(schema.demoRuns)
      .set({ status: 'failed', error: 'abandoned', finishedAt: now })
      .where(eq(schema.demoRuns.status, 'running'))
    const [row] = await tx
      .insert(schema.demoRuns)
      .values({
        status: 'running',
        startedAt: now,
        updatedAt: now,
        stateJson: JSON.stringify(initialState(opts.vendorBase)),
        requester: opts.requester,
      })
      .returning()
    return { run: view(row!, now), joined: false }
  })
}

/** Advances run `id` by one bounded tick. Returns its view (unchanged if another tick holds the lease). */
export async function tick(gw: Gateway, id: number): Promise<RunView | null> {
  const db = gw.ledger.db
  const now = Date.now()
  const [claimed] = await db
    .update(schema.demoRuns)
    .set({ leaseUntil: now + LEASE_MS })
    .where(
      and(
        eq(schema.demoRuns.id, id),
        eq(schema.demoRuns.status, 'running'),
        or(isNull(schema.demoRuns.leaseUntil), lt(schema.demoRuns.leaseUntil, now)),
      ),
    )
    .returning()
  if (!claimed) {
    const row = await first(db.select().from(schema.demoRuns).where(eq(schema.demoRuns.id, id)))
    return row ? view(row) : null
  }
  const state = JSON.parse(claimed.stateJson) as RunState
  let status: RunView['status'] = 'running'
  let error: string | null = null
  try {
    status = await advance(gw, claimed.id, claimed.startedAt, state)
  } catch (err) {
    status = 'failed'
    error = (err as Error).message.slice(0, 500)
  }
  const done = Date.now()
  const [row] = await db
    .update(schema.demoRuns)
    .set({
      stateJson: JSON.stringify(state),
      status,
      error,
      updatedAt: done,
      leaseUntil: null,
      ...(status === 'running' ? {} : { finishedAt: done }),
    })
    .where(eq(schema.demoRuns.id, id))
    .returning()
  return row ? view(row) : null
}

/** Runs what is due, within the tick budget. Each step is recorded in `state.done`, so it runs once. */
async function advance(
  gw: Gateway,
  runId: number,
  startedAt: number,
  state: RunState,
): Promise<RunView['status']> {
  const deadline = Date.now() + TICK_BUDGET_MS
  const elapsed = () => Date.now() - startedAt
  const agent = (id: string) => state.agents.find((a) => a.id === id)!

  // timeline steps first, one per tick (each can take a few seconds on devnet)
  const step = STEPS.find((s) => elapsed() >= s.at && !state.done.includes(s.id))
  if (step && step.id !== 'finish') {
    if (step.id === 'mirror') {
      const coder = agent('coder-01')
      const row = await gw.store.agent(coder.id)
      try {
        await gw.sessions.open(row!, {
          vendorId: 'inference-a',
          taskId: `r${runId}-${coder.id}-mirror`,
          endpoint: `${state.vendorBase}/mirror/v1/infer`,
          deposit: BigInt(coder.deposit),
        })
        coder.note = 'the mirror was NOT blocked'
      } catch (err) {
        coder.note = `blocked before signing: ${(err as Error).message}`
      }
      coder.vendorId = 'inference-a' // falls back to the registered endpoint; the old channel goes idle
      coder.sessionId = null
    } else if (step.id === 'inject') {
      agent('rogue-01').intervalMs = 0
    } else if (step.id === 'sweep') {
      await gw.sessions.sweepIdle(30_000)
    }
    state.done.push(step.id)
    return 'running'
  }
  if (step?.id === 'finish') return finish(gw, runId, state, deadline)

  // one channel open per tick
  const opener = state.agents.find((a) => !a.stopped && !a.sessionId)
  if (opener) {
    const row = await gw.store.agent(opener.id)
    try {
      const r = await gw.sessions.open(row!, {
        vendorId: opener.vendorId,
        taskId: `r${runId}-${opener.id}-task-${opener.task}`,
        taskLabel: `summarize #${opener.task}`,
        deposit: BigInt(opener.deposit),
      })
      opener.sessionId = r.sessionId
      opener.lastCallAt = elapsed()
    } catch (err) {
      opener.note = (err as Error).message
      if (++opener.openFailures >= 3) opener.stopped = true
    }
    return 'running'
  }

  // pay: round-robin over the agents whose next call is due, until nothing is due or the budget is spent
  while (Date.now() < deadline) {
    let paid = false
    for (const a of state.agents) {
      if (a.stopped || !a.sessionId || elapsed() < a.lastCallAt + a.intervalMs) continue
      await pay(gw, runId, a, elapsed)
      paid = true
      if (Date.now() >= deadline) break
    }
    if (!paid) break
  }
  return 'running'
}

async function pay(gw: Gateway, runId: number, a: AgentState, elapsed: () => number): Promise<void> {
  const s = await gw.sessions.find(a.sessionId!)
  if (!s) {
    a.sessionId = null
    return
  }
  const taskId = `r${runId}-${a.id}-task-${a.task}`
  const prompts = PROMPTS[a.id] ?? ['summarize']
  try {
    const r = await gw.sessions.voucher(a.id, a.sessionId!, {
      units: s.unitsPerCall,
      unitPrice: s.pricePerCall / BigInt(s.unitsPerCall),
      prompt: prompts[(a.task + a.taskCalls) % prompts.length],
      taskId,
      taskLabel: `summarize #${a.task}`,
    })
    a.taskCalls++
    if (r.outcome === 'ok') a.taskOk++
  } catch (err) {
    if (err instanceof GatewayError && err.body.rule === 'CHANNEL_DEPOSIT') {
      a.sessionId = null // escrow used up: open a fresh channel next tick
    } else {
      // a refused voucher (policy, a kill, a closed channel): this agent is done
      a.stopped = true
      a.note = (err as Error).message
    }
  }
  a.lastCallAt = elapsed()
  if (a.taskOk >= CALLS_PER_TASK || a.taskCalls >= MAX_CALLS_PER_TASK || a.stopped) {
    if (a.taskCalls > 0) {
      const status = a.taskOk >= CALLS_PER_TASK ? 'completed' : 'failed'
      await gw.store.completeTask(taskId, status)
      await gw.bus.emit({
        type: 'task_completed',
        agentId: a.id,
        message: `${a.id} marked task summarize #${a.task} ${status}`,
        data: { taskId, status },
      })
    }
    a.task++
    a.taskCalls = 0
    a.taskOk = 0
  }
}

/** Close-out, one piece per tick: each agent's channel, then the float sweep, then the receipts. */
async function finish(
  gw: Gateway,
  runId: number,
  state: RunState,
  deadline: number,
): Promise<RunView['status']> {
  for (const a of state.agents) a.stopped = true
  for (const a of state.agents) {
    const key = `close:${a.id}`
    if (state.done.includes(key)) continue
    const open = (await gw.store.channels(['open'])).filter((c) => c.agentId === a.id)
    for (const c of open) await gw.sessions.close(c.id, 'demo run finished').catch(() => null)
    state.done.push(key)
    if (Date.now() >= deadline) return 'running'
  }
  if (!state.done.includes('sweep-all')) {
    await gw.sessions.sweepIdle(0)
    state.done.push('sweep-all')
    if (Date.now() >= deadline) return 'running'
  }
  if (!state.done.includes('anchor')) {
    await gw.anchorer.anchorAll()
    state.done.push('anchor')
  }
  state.done.push('finish')
  void runId
  return 'done'
}
