import { createSolanaRpc, type KeyPairSigner } from '@solana/kit'
import { Mppx, session } from '@solana/mpp/server'
import type { ClusterConfig } from '@tabula/solana'
import { Hono } from 'hono'
import { pricePerCall, type VendorConfig } from './config.js'
import { mulberry32 } from './rng.js'

export type Outcome = 'ok' | 'error' | 'empty' | 'timeout'

export interface VendorDeps {
  readonly cluster: ClusterConfig
  readonly mint: string
  readonly payee: KeyPairSigner
  readonly operator: KeyPairSigner
  /** How long a "timeout" call hangs before answering (the caller should give up first). */
  readonly timeoutHoldMs?: number
  /** Override the challenge-binding secret (default: random per process). */
  readonly secretKey?: string
  /** Skip artificial latency (tests). */
  readonly noLatency?: boolean
}

export interface VendorStats {
  challenges: number
  paidCalls: number
  outcomes: Record<Outcome, number>
  rejected: number
}

/** Network slug the mpp server must use: surfnet blockhashes carry a prefix only `localnet` accepts. */
function mppNetwork(cluster: ClusterConfig): string {
  return cluster.name === 'devnet' ? 'devnet' : 'localnet'
}

export function createVendorApp(config: VendorConfig, deps: VendorDeps) {
  const network = mppNetwork(deps.cluster)
  const price = pricePerCall(config)
  const method = session({
    amount: price,
    currency: deps.mint,
    decimals: 6,
    feePayer: true,
    feePayerSigner: deps.operator,
    gracePeriodSeconds: config.gracePeriodSeconds,
    idleTimeoutSeconds: config.idleTimeoutSeconds,
    network,
    recipient: deps.payee.address,
    rpc: createSolanaRpc(deps.cluster.rpcUrl),
    signer: deps.payee,
    suggestedDeposit: config.suggestedDeposit,
    unitType: config.unitName,
  })
  const secretKey =
    deps.secretKey ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
  const mppx = Mppx.create({ methods: [method], realm: `tabula-demo-${config.id}`, secretKey })
  const gate = mppx.session({
    amount: price.toString(),
    currency: deps.mint,
    description: `${config.name}: ${config.unitsPerCall} ${config.unitName}s per call`,
    methodDetails: { channelProgram: deps.cluster.paymentChannelsProgram, network },
    recipient: deps.payee.address,
  })

  const rand = mulberry32(config.seed)
  const stats: VendorStats = {
    challenges: 0,
    paidCalls: 0,
    outcomes: { ok: 0, error: 0, empty: 0, timeout: 0 },
    rejected: 0,
  }
  let down = false
  const holdMs = deps.timeoutHoldMs ?? 8_000

  const nextOutcome = (): { outcome: Outcome; latency: number } => {
    const r = rand()
    const latency = Math.max(
      5,
      Math.round(config.latencyMs.mean + (rand() * 2 - 1) * config.latencyMs.jitter),
    )
    let outcome: Outcome = 'ok'
    if (r < config.errorRate) outcome = 'error'
    else if (r < config.errorRate + config.emptyRate) outcome = 'empty'
    else if (r < config.errorRate + config.emptyRate + config.timeoutRate) outcome = 'timeout'
    return { outcome, latency }
  }

  const app = new Hono()

  app.get('/health', (c) =>
    c.json({
      id: config.id,
      name: config.name,
      payee: deps.payee.address,
      mint: deps.mint,
      program: deps.cluster.paymentChannelsProgram,
      network,
      unitName: config.unitName,
      unitsPerCall: config.unitsPerCall,
      unitPrice: config.unitPrice.toString(),
      pricePerCall: price.toString(),
      down,
    }),
  )

  app.get('/admin/stats', (c) => c.json({ ...stats, down }))
  app.post('/admin/down', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { down?: boolean }
    down = body.down ?? true
    return c.json({ down })
  })

  app.get('/v1/infer', async (c) => {
    if (down) return c.json({ error: 'vendor unavailable' }, 503)
    const result = (await gate(c.req.raw)) as
      | { status: 402; challenge: Response }
      | { status: 200; withReceipt: (r: Response) => Response }
    if (result.status === 402) {
      if (c.req.header('authorization')) stats.rejected++
      else stats.challenges++
      return result.challenge
    }
    stats.paidCalls++
    const { outcome, latency } = nextOutcome()
    stats.outcomes[outcome]++
    if (!deps.noLatency) await new Promise((r) => setTimeout(r, outcome === 'timeout' ? holdMs : latency))
    const prompt = c.req.query('prompt') ?? ''
    let response: Response
    switch (outcome) {
      case 'error':
        response = Response.json({ error: 'upstream model failed' }, { status: 500 })
        break
      case 'empty':
        response = Response.json({ completion: '', tokens: 0 })
        break
      default:
        response = Response.json({
          completion: `[${config.id}] summary of "${prompt.slice(0, 40)}" (${config.unitsPerCall} ${config.unitName}s)`,
          tokens: config.unitsPerCall,
        })
    }
    return result.withReceipt(response)
  })

  return { app, stats, setDown: (v: boolean) => (down = v), price }
}
