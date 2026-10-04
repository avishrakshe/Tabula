import { GatewayClient, type SessionInfo } from './client'

export type AgentLog = (agentId: string, message: string) => void

export interface AgentConfig {
  readonly id: string
  readonly apiKey: string
  readonly gatewayUrl: string
  readonly vendorId: string
  readonly taskType: string
  /** Pause between paid calls. */
  readonly intervalMs: number
  /** Successful calls a task needs before it counts as completed. */
  readonly callsPerTask: number
  /** Give up on a task after this many paid calls. */
  readonly maxCallsPerTask: number
  readonly prompts: readonly string[]
  readonly log?: AgentLog
}

/**
 * A scripted agent: keeps one channel per vendor open across tasks, pays per call through the
 * gateway, and stops cleanly when Tabula refuses it. Behaviour can be changed while it runs
 * (rate spikes after a prompt injection, switching vendors).
 */
export class DemoAgent {
  readonly client: GatewayClient
  intervalMs: number
  vendorId: string
  readonly sessions = new Map<string, SessionInfo>()
  stopped = false
  stoppedBy: string | null = null
  completed = 0
  failed = 0
  paid = 0
  #taskSeq = 0
  #running: Promise<void> | null = null

  constructor(readonly cfg: AgentConfig) {
    this.client = new GatewayClient(cfg.gatewayUrl, cfg.apiKey)
    this.intervalMs = cfg.intervalMs
    this.vendorId = cfg.vendorId
  }

  log(message: string): void {
    this.cfg.log?.(this.cfg.id, message)
  }

  /** Opens (or reuses) a session with `vendorId`; `endpoint` lets a misled agent try another URL. */
  async session(vendorId: string, opts: { endpoint?: string } = {}): Promise<SessionInfo | null> {
    if (!opts.endpoint) {
      const existing = this.sessions.get(vendorId)
      if (existing) return existing
    }
    const r = await this.client.openSession(vendorId, `${this.cfg.id}-${vendorId}-session`, opts)
    if (!r.session) {
      this.log(
        `could not open a session with ${vendorId}${opts.endpoint ? ` at ${opts.endpoint}` : ''}: ${r.body.message ?? r.status}`,
      )
      return null
    }
    this.sessions.set(vendorId, r.session)
    this.log(`opened a channel with ${r.session.vendor.name} ($${Number(r.session.deposit) / 1e6} escrow)`)
    return r.session
  }

  start(): void {
    this.#running ??= this.#loop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.#running
  }

  async #loop(): Promise<void> {
    while (!this.stopped) {
      const session = await this.session(this.vendorId)
      if (!session) {
        this.stopped = true
        break
      }
      const taskId = `${this.cfg.id}-task-${++this.#taskSeq}`
      const label = `${this.cfg.taskType} #${this.#taskSeq}`
      let ok = 0
      let calls = 0
      while (!this.stopped && ok < this.cfg.callsPerTask && calls < this.cfg.maxCallsPerTask) {
        const prompt = this.cfg.prompts[(this.paid + calls) % this.cfg.prompts.length] ?? 'summarize'
        const current = this.sessions.get(this.vendorId) ?? session
        const r = await this.client.pay(current, { prompt, taskId, taskLabel: label })
        calls++
        if (r.status === 402 || r.status === 403 || r.status === 409) {
          // Tabula stopped paying: a policy violation, a kill, or a closed channel
          this.stoppedBy = String(r.body.message ?? r.body.error ?? r.status)
          this.log(`payment refused: ${this.stoppedBy}`)
          if (r.body.rule === 'CHANNEL_DEPOSIT') {
            this.sessions.delete(this.vendorId)
            break
          }
          this.stopped = true
          break
        }
        if (!r.ok) {
          this.log(`gateway error ${r.status}: ${r.body.message ?? ''}`)
        } else {
          this.paid++
          if (r.body.outcome === 'ok') ok++
        }
        if (this.intervalMs > 0) await new Promise((res) => setTimeout(res, this.intervalMs))
      }
      if (calls === 0) continue
      const status = ok >= this.cfg.callsPerTask ? 'completed' : 'failed'
      if (status === 'completed') this.completed++
      else this.failed++
      await this.client.completeTask(taskId, status).catch(() => {})
    }
  }
}
