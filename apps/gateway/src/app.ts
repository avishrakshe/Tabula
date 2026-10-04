import cors from '@fastify/cors'
import { schema } from '@tabula/ledger'
import { explorerTxUrl } from '@tabula/solana'
import { desc, eq } from 'drizzle-orm'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { GatewayEvent } from './events.js'
import type { Gateway } from './gateway.js'
import { exportCsv, overview, reconcileAll, scorecards } from './reports.js'
import { GatewayError } from './sessions.js'

declare module 'fastify' {
  interface FastifyRequest {
    agent?: schema.AgentRow
  }
}

const bigintJson = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

const amount = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((v) => BigInt(v))

const OpenBody = z.object({
  vendorId: z.string().min(1),
  taskId: z.string().min(1),
  taskLabel: z.string().optional(),
  taskType: z.string().optional(),
  endpoint: z.string().url().optional(),
  deposit: amount.optional(),
})

const VoucherBody = z.object({
  units: z.number(),
  unitPrice: amount,
  prompt: z.string().max(2000).optional(),
  requestId: z.string().max(128).optional(),
  taskId: z.string().min(1).max(128).optional(),
  taskLabel: z.string().max(200).optional(),
})

const KillBody = z.object({ agentId: z.string().min(1), reason: z.string().max(500).optional() })
const TaskBody = z.object({ status: z.enum(['completed', 'failed']) })

export async function buildApp(gw: Gateway): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.setReplySerializer((payload) => bigintJson(payload))
  // the plugin's default methods are GET, HEAD and POST; the dashboard also saves policies with PUT
  await app.register(cors, { origin: true, methods: ['GET', 'HEAD', 'POST', 'PUT'] })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof GatewayError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, ...err.body })
    }
    if (err instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'BAD_REQUEST',
        message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      })
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) console.error('[gateway]', err)
    return reply
      .code(status)
      .send({ error: status >= 500 ? 'INTERNAL' : 'BAD_REQUEST', message: (err as Error).message })
  })

  const bearer = (req: FastifyRequest) => {
    const h = req.headers.authorization
    return h?.startsWith('Bearer ') ? h.slice(7) : undefined
  }

  const requireAgent = async (req: FastifyRequest, reply: FastifyReply) => {
    const key = bearer(req)
    const agent = key ? await gw.store.agentByApiKey(key) : undefined
    if (!agent)
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'missing or unknown agent API key' })
    req.agent = agent
  }

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(req) ?? (req.query as { token?: string }).token
    if (token !== gw.config.adminToken)
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'admin token required' })
  }

  app.get('/health', async () => ({
    ok: true,
    cluster: gw.config.cluster.name,
    rpc: gw.config.cluster.rpcUrl,
    mint: gw.config.mint,
    treasury: gw.treasury.kind,
    openSessions: gw.sessions.sessions().filter((s) => s.status === 'open').length,
  }))

  // ---- agent API -------------------------------------------------------------------------
  app.post('/v1/sessions', { preHandler: requireAgent }, async (req, reply) => {
    const body = OpenBody.parse(req.body)
    const result = await gw.sessions.open(req.agent!, body)
    return reply.code(201).send(result)
  })

  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/voucher',
    { preHandler: requireAgent },
    async (req) => {
      const body = VoucherBody.parse(req.body)
      return gw.sessions.voucher(req.agent!.id, req.params.id, body)
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/sessions/:id/close',
    { preHandler: requireAgent },
    async (req) => {
      const s = gw.sessions.session(req.params.id)
      if (!s || s.agentId !== req.agent!.id) throw new GatewayError(404, 'NO_SESSION', 'no such session')
      return gw.sessions.close(req.params.id, 'closed by agent')
    },
  )

  app.post<{ Params: { id: string } }>(
    '/v1/tasks/:id/complete',
    { preHandler: requireAgent },
    async (req) => {
      const { status } = TaskBody.parse(req.body)
      const task = await gw.store.task(req.params.id)
      if (!task || task.agentId !== req.agent!.id) throw new GatewayError(404, 'NO_TASK', 'no such task')
      await gw.store.completeTask(task.id, status)
      await gw.bus.emit({
        type: 'task_completed',
        agentId: task.agentId,
        message: `${task.agentId} marked task ${task.label} ${status}`,
        data: { taskId: task.id, status },
      })
      return { ok: true }
    },
  )

  app.get('/v1/me', { preHandler: requireAgent }, async (req) => {
    const a = req.agent!
    return {
      id: a.id,
      status: gw.policy.agentStatus(a.id),
      sessions: gw.sessions
        .sessions()
        .filter((s) => s.agentId === a.id)
        .map((s) => ({ id: s.id, vendorId: s.vendorId, status: s.status })),
    }
  })

  // ---- admin / dashboard API --------------------------------------------------------------
  app.post('/v1/kill', { preHandler: requireAdmin }, async (req) => {
    const { agentId, reason } = KillBody.parse(req.body)
    if (agentId === 'all') {
      await gw.sessions.setGlobalKill(true, 'operator')
      const agents = await gw.store.agents()
      const results = await Promise.all(
        agents.map((a) => gw.sessions.kill(a.id, reason ?? 'global kill switch')),
      )
      return { killed: agents.map((a) => a.id), closed: results.flat() }
    }
    if (!(await gw.store.agent(agentId))) throw new GatewayError(404, 'NO_AGENT', `no agent ${agentId}`)
    const closed = await gw.sessions.kill(agentId, reason ?? 'stopped by operator')
    return { killed: [agentId], closed }
  })

  app.post('/v1/revive', { preHandler: requireAdmin }, async (req) => {
    const { agentId } = KillBody.parse(req.body)
    if (agentId === 'all') {
      await gw.sessions.setGlobalKill(false, 'operator')
      for (const a of await gw.store.agents()) await gw.sessions.revive(a.id)
      return { ok: true }
    }
    await gw.sessions.revive(agentId)
    return { ok: true }
  })

  app.get('/v1/stream', { preHandler: requireAdmin }, async (req, reply) => {
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    })
    const send = (e: GatewayEvent) => res.write(`event: ${e.type}\ndata: ${bigintJson(e)}\n\n`)
    res.write(`event: hello\ndata: ${bigintJson({ ts: Date.now(), cluster: gw.config.cluster.name })}\n\n`)
    const unsubscribe = gw.bus.subscribe(send)
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
    req.raw.on('close', () => {
      clearInterval(ping)
      unsubscribe()
    })
  })

  app.get('/v1/agents', { preHandler: requireAdmin }, async () => {
    const agents = await gw.store.agents()
    return Promise.all(
      agents.map(async ({ apiKeyHash: _hidden, ...a }) => {
        const allowance = await gw.treasury.allowance(a.id).catch(() => null)
        return {
          ...a,
          status: gw.policy.agentStatus(a.id),
          allowance: allowance
            ? {
                address: allowance.address,
                perPeriod: allowance.perPeriod.toString(),
                remaining: allowance.remaining.toString(),
                periodS: allowance.periodS.toString(),
              }
            : null,
        }
      }),
    )
  })

  app.get('/v1/float', { preHandler: requireAdmin }, async () => gw.sessions.floatView())

  app.post('/v1/float/sweep', { preHandler: requireAdmin }, async (req) => {
    const { idleSeconds } = z
      .object({ idleSeconds: z.number().nonnegative().optional() })
      .parse(req.body ?? {})
    return gw.sessions.sweepIdle(idleSeconds === undefined ? undefined : idleSeconds * 1000)
  })

  app.get('/v1/vendors', { preHandler: requireAdmin }, async () => gw.store.vendors())

  app.get<{ Querystring: { limit?: string; agentId?: string } }>(
    '/v1/vouchers',
    { preHandler: requireAdmin },
    async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 200), 5000)
      const q = gw.ledger.db.select().from(schema.vouchers)
      const rows = req.query.agentId
        ? await q
            .where(eq(schema.vouchers.agentId, req.query.agentId))
            .orderBy(desc(schema.vouchers.id))
            .limit(limit)
        : await q.orderBy(desc(schema.vouchers.id)).limit(limit)
      return rows
    },
  )

  app.get('/v1/channels', { preHandler: requireAdmin }, async () => gw.store.channels())

  app.get('/v1/challenges', { preHandler: requireAdmin }, async () =>
    gw.ledger.db.select().from(schema.challengeChecks).orderBy(desc(schema.challengeChecks.id)).limit(200),
  )

  app.get<{ Querystring: { limit?: string } }>('/v1/events', { preHandler: requireAdmin }, async (req) =>
    gw.ledger.db
      .select()
      .from(schema.events)
      .orderBy(desc(schema.events.id))
      .limit(Math.min(Number(req.query.limit ?? 200), 2000)),
  )

  // ---- policies --------------------------------------------------------------------------
  app.get('/v1/policies', { preHandler: requireAdmin }, async () => {
    const rows = await gw.ledger.db.select().from(schema.policies).orderBy(desc(schema.policies.id))
    return rows.map((r) => ({ ...r, rules: JSON.parse(r.rulesJson) }))
  })

  app.put('/v1/policies', { preHandler: requireAdmin }, async (req) => {
    const body = z
      .object({
        scope: z.enum(['global', 'agent', 'vendor']),
        scopeId: z.string().min(1).nullable().optional(),
        rules: z.record(z.string(), z.unknown()),
        updatedBy: z.string().max(80).optional(),
      })
      .parse(req.body)
    if (body.scope !== 'global' && !body.scopeId)
      throw new GatewayError(400, 'BAD_REQUEST', 'scopeId is required')
    try {
      const version = await gw.policy.setPolicy(
        body.scope,
        body.scope === 'global' ? null : (body.scopeId ?? null),
        body.rules as never,
        body.updatedBy ?? 'dashboard',
      )
      return { ok: true, version }
    } catch (err) {
      throw new GatewayError(400, 'INVALID_POLICY', (err as Error).message)
    }
  })

  // ---- reports ---------------------------------------------------------------------------
  app.get('/v1/overview', { preHandler: requireAdmin }, async () => ({
    ...(await overview(gw.ledger.db)),
    cluster: gw.config.cluster.name,
    treasury: gw.treasury.kind,
    vault: gw.treasury.vaultAddress,
    vaultBalance: (await gw.treasury.vaultBalance().catch(() => null))?.toString() ?? null,
  }))

  app.get('/v1/reconcile', { preHandler: requireAdmin }, async () =>
    reconcileAll(gw.ledger.db, gw.rpc, gw.config.cluster),
  )

  app.get('/v1/scores', { preHandler: requireAdmin }, async () => scorecards(gw.ledger.db))

  app.get('/v1/export.csv', { preHandler: requireAdmin }, async (_req, reply) => {
    const csv = await exportCsv(gw.ledger.db, gw.config.cluster)
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="tabula-ledger-${new Date().toISOString().slice(0, 10)}.csv"`,
      )
      .send(csv)
  })

  // ---- onchain receipts ------------------------------------------------------------------
  app.get('/v1/batches', { preHandler: requireAdmin }, async () =>
    gw.ledger.db.select().from(schema.batches).orderBy(desc(schema.batches.id)).limit(200),
  )

  app.get<{ Params: { id: string } }>('/v1/batches/:id', { preHandler: requireAdmin }, async (req) => {
    const id = Number(req.params.id)
    const batch = await gw.ledger.db.select().from(schema.batches).where(eq(schema.batches.id, id)).get()
    if (!batch) throw new GatewayError(404, 'NO_BATCH', `no batch ${id}`)
    return {
      batch,
      rows: await gw.anchorer.batchRows(id),
      explorerUrl: batch.txSignature ? explorerTxUrl(gw.config.cluster, batch.txSignature) : null,
      leaf: 'sha256(0x00 || canonical JSON row)',
      node: 'sha256(0x01 || min(a,b) || max(a,b))',
    }
  })

  app.post<{ Params: { id: string } }>(
    '/v1/batches/:id/verify',
    { preHandler: requireAdmin },
    async (req) => {
      try {
        return await gw.anchorer.verify(Number(req.params.id))
      } catch (err) {
        throw new GatewayError(404, 'NO_BATCH', (err as Error).message)
      }
    },
  )

  app.post('/v1/anchor', { preHandler: requireAdmin }, async () => ({
    anchored: await gw.anchorer.anchorAll(),
  }))

  return app
}
