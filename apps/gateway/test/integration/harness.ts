import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ClusterConfig,
  createRpc,
  loadOrCreateKeypair,
  resolveCluster,
  SANDBOX_RPC_URL,
  setSolBalance,
} from '@tabula/solana'
import { demoVendor, type RunningVendor, startVendor } from '@tabula/vendor-mock'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { type AgentSpec, registerAgent, registerVendor } from '../../src/bootstrap.js'
import type { GatewayConfig } from '../../src/config.js'
import { createGateway, type Gateway } from '../../src/gateway.js'
import { ensureAllowances, ensureTreasury } from '../../src/treasury-setup.js'

export interface Harness {
  readonly cluster: ClusterConfig
  readonly gw: Gateway
  readonly app: FastifyInstance
  readonly vendors: Record<string, RunningVendor>
  readonly apiKeys: Record<string, string>
  readonly adminToken: string
  call(agent: string, method: 'GET' | 'POST', url: string, body?: unknown): Promise<JsonResponse>
  admin(method: 'GET' | 'POST', url: string, body?: unknown): Promise<JsonResponse>
  stop(): Promise<void>
}

// biome-ignore lint/suspicious/noExplicitAny: tests assert on loosely-typed JSON response bodies
export type JsonResponse = { status: number; json: any }

export async function startHarness(opts: {
  agents: AgentSpec[]
  globalPolicy?: Record<string, unknown>
  vendorOverrides?: Record<string, { noLatency?: boolean; timeoutHoldMs?: number }>
  gateway?: Partial<GatewayConfig>
  /** 'ceiling' = real Squads vault + per-agent Subscriptions allowance (daily budget); default sandbox faucet. */
  treasury?: 'faucet' | 'ceiling'
}): Promise<Harness> {
  const keysDir = mkdtempSync(join(tmpdir(), 'tabula-it-keys-'))
  process.env.TABULA_KEYS_DIR = keysDir
  const cluster = resolveCluster(
    (process.env.TABULA_CLUSTER as 'sandbox' | 'localnet') ?? 'sandbox',
    process.env.TABULA_RPC_URL || undefined,
  )
  const mint = cluster.defaultMint!
  const vendors: Record<string, RunningVendor> = {}
  for (const id of ['inference-a', 'inference-b', 'mirror']) {
    vendors[id] = await startVendor(demoVendor(id), cluster, mint, {
      port: 0,
      ...(opts.vendorOverrides?.[id] ?? {}),
    })
  }
  const adminToken = 'it-admin'
  const config: GatewayConfig = {
    port: 0,
    host: '127.0.0.1',
    dbPath: join(keysDir, 'ledger-pg'),
    cluster,
    mint,
    adminToken,
    vendorTimeoutMs: 2_000,
    cooperativeCloseTimeoutMs: 30_000,
    demoFaucet: true,
    anchorEvery: 50,
    anchorIntervalMs: 0,
    idleSweepMs: 0,
    idleAfterMs: 5 * 60_000,
    treasuryFile: join(keysDir, 'treasury.json'),
    serverless: false,
    closeStallMs: 90_000,
    ...opts.gateway,
  }
  if (opts.treasury === 'ceiling') {
    const admin = await loadOrCreateKeypair('tabula-admin')
    await setSolBalance(cluster.rpcUrl, admin.address, 20_000_000_000n)
    const rpc = createRpc(cluster.rpcUrl)
    const state = await ensureTreasury({
      rpc,
      cluster,
      mint,
      admin,
      createKey: await loadOrCreateKeypair('treasury-createkey'),
      file: config.treasuryFile,
      fundVault: 100_000_000n,
    })
    const specs = []
    for (const a of opts.agents) {
      const payer = await loadOrCreateKeypair(`agent-${a.id}-payer`)
      specs.push({ agentId: a.id, payer: payer.address, amountPerPeriod: BigInt(a.dailyBudget) })
    }
    await ensureAllowances({ rpc, cluster, mint, admin, file: config.treasuryFile, state, specs })
  }
  const gw = await createGateway(config)
  await setSolBalance(cluster.rpcUrl, gw.custody.operator.address, 10_000_000_000n)
  for (const id of ['inference-a', 'inference-b']) {
    const v = vendors[id]!
    await registerVendor(gw, {
      id,
      name: v.config.name,
      endpoint: `${v.url}/v1/infer`,
      payeePubkey: v.payee,
      mint,
      programId: cluster.paymentChannelsProgram,
      unitName: v.config.unitName,
      unitPrice: Number(v.config.unitPrice),
      maxUnitPrice: Number(v.config.unitPrice) * 2,
      taskType: v.config.taskType,
    })
  }
  if (opts.globalPolicy) await gw.policy.setPolicy('global', null, opts.globalPolicy, 'test')
  const apiKeys: Record<string, string> = {}
  for (const a of opts.agents) apiKeys[a.id] = (await registerAgent(gw, a))!
  const app = await buildApp(gw)
  const inject = async (
    headers: Record<string, string>,
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
  ) => {
    const res = await app.inject({
      method,
      url,
      headers,
      payload: body === undefined ? undefined : (body as object),
    })
    let json: unknown = null
    try {
      json = res.json()
    } catch {
      json = res.body
    }
    return { status: res.statusCode, json }
  }
  return {
    cluster,
    gw,
    app,
    vendors,
    apiKeys,
    adminToken,
    call: (agent, method, url, body) =>
      inject({ authorization: `Bearer ${apiKeys[agent]}` }, method, url, body),
    admin: (method, url, body) => inject({ authorization: `Bearer ${adminToken}` }, method, url, body),
    stop: async () => {
      await app.close()
      await gw.close()
      await Promise.all(Object.values(vendors).map((v) => v.close()))
    },
  }
}

export const sandboxReachable = async (): Promise<boolean> => {
  try {
    const res = await fetch(process.env.TABULA_RPC_URL || SANDBOX_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: AbortSignal.timeout(8_000),
    })
    return res.ok
  } catch {
    return false
  }
}
