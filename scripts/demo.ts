/**
 * `pnpm demo` — the full Tabula story, end to end, on the Solana Payment Sandbox:
 *
 *   t=0     three agents open channels and pay per call (research-01, coder-01, rogue-01)
 *   t=25s   coder-01 reads a poisoned page and tries a "faster mirror" whose 402 names another payee:
 *           blocked before anything is signed (PAYEE_MISMATCH); it falls back to the real vendor
 *   t=45s   rogue-01 reads a prompt-injected ticket and calls as fast as it can: the velocity rule
 *           blocks one specific voucher unsigned, kills the agent, closes its channel, sweeps the
 *           refund back to the Squads vault
 *   t=120s  the float manager closes the channel coder-01 abandoned
 *   t=150s  everyone stops; channels close; the ledger is anchored onchain and verified; every
 *           channel reconciles; vendor scorecards; CSV export
 *
 * Requires `pnpm setup` first (Squads vault + allowances). Deterministic vendor behaviour (seeded);
 * timings scale with DEMO_TIME_SCALE (e.g. 0.5 for a faster run). `--hold` keeps the gateway and
 * vendors running afterwards so the dashboard can be explored.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CODING_PROMPTS,
  DemoAgent,
  INJECTED_TICKET,
  POISONED_PAGE,
  RESEARCH_PROMPTS,
  TICKET_PROMPTS,
} from '@tabula/agents'
import {
  buildApp,
  configFromEnv,
  createGateway,
  exportCsv,
  type GatewayEvent,
  loadTreasuryState,
  newApiKey,
  reconcileAll,
  registerAgent,
  scorecards,
} from '@tabula/gateway'
import { schema } from '@tabula/ledger'
import { formatUsd } from '@tabula/policy'
import { DEMO_VENDORS, startVendor } from '@tabula/vendor-mock'
import { DEMO_AGENTS, GLOBAL_POLICY, registerDemoVendors } from './lib/demo-config.js'

const SCALE = Number(process.env.DEMO_TIME_SCALE ?? 1)
const HOLD = process.argv.includes('--hold')
const base = configFromEnv()
const dataDir = dirname(base.treasuryFile)
const config = {
  ...base,
  dbPath: process.env.TABULA_DB_PATH || join(dataDir, 'demo-pg'),
  anchorEvery: 40,
  anchorIntervalMs: 0,
  idleAfterMs: Math.round(60_000 * SCALE),
}
const eventsFile = join(dataDir, 'demo-events.jsonl')
const t0 = Date.now()
const stamp = () => {
  const s = Math.floor((Date.now() - t0) / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
const say = (who: string, msg: string) => console.log(`[${stamp()}] ${who.padEnd(12)} ${msg}`)
const sleepUntil = async (seconds: number) => {
  const target = t0 + seconds * 1000 * SCALE
  while (Date.now() < target) await new Promise((r) => setTimeout(r, Math.min(500, target - Date.now())))
}

async function main() {
  if (!loadTreasuryState(config.treasuryFile)) throw new Error('no treasury yet: run `pnpm setup` first')
  // every run starts from an empty ledger (a PGlite directory locally; never a remote database)
  if (/^postgres(ql)?:\/\//.test(config.dbPath))
    throw new Error('pnpm demo resets its ledger: use a local path')
  rmSync(config.dbPath, { recursive: true, force: true })
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(eventsFile, '')

  // vendors (stock @solana/mpp session servers) and the gateway, all local; the chain is the sandbox
  const vendors = []
  for (const v of DEMO_VENDORS) vendors.push(await startVendor(v, config.cluster, config.mint))
  const gw = await createGateway(config)
  if (gw.treasury.kind !== 'squads-allowance')
    throw new Error('expected the Squads-vault treasury from pnpm setup')
  await gw.policy.setPolicy('global', null, GLOBAL_POLICY, 'demo')
  await registerDemoVendors(gw)
  const keys: Record<string, string> = {}
  for (const a of DEMO_AGENTS) keys[a.id] = (await registerAgent(gw, a, newApiKey()))!
  const app = await buildApp(gw)
  await app.listen({ port: config.port, host: config.host })
  const gatewayUrl = `http://${config.host}:${config.port}`
  // float an earlier (interrupted) run left in agent wallets goes back first, so the vault's
  // change over this run is exactly what vendors settle
  const leftover = await gw.sessions.sweepIdle(0)
  if (BigInt(leftover.reclaimed) > 0n)
    console.log(
      `Returned ${formatUsd(BigInt(leftover.reclaimed))} of float left by an earlier run to the vault`,
    )
  const vaultStart = (await gw.treasury.vaultBalance()) ?? 0n
  console.log(
    `Tabula demo on ${config.cluster.name}. Gateway ${gatewayUrl} (dashboard: admin token "${config.adminToken}")`,
  )
  console.log(`Treasury vault ${gw.treasury.vaultAddress}: ${formatUsd(vaultStart)}\n`)

  // record the run for the hosted dashboard's replay mode: the event stream plus API snapshots
  const replayEvents: unknown[] = []
  const snapshots: Record<string, unknown>[] = []
  const get = async (url: string) =>
    (
      await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${config.adminToken}` } })
    ).json()
  const snapshot = async () => ({
    t: Date.now() - t0,
    overview: await get('/v1/overview'),
    agents: await get('/v1/agents'),
    vendors: await get('/v1/vendors'),
    float: await get('/v1/float'),
    channels: await get('/v1/channels'),
    scores: await get('/v1/scores'),
    reconcile: await get('/v1/reconcile'),
    batches: await get('/v1/batches'),
    challenges: await get('/v1/challenges'),
    policies: await get('/v1/policies'),
  })
  let snapping = false
  const snapTimer = setInterval(() => {
    if (snapping) return
    snapping = true
    snapshot()
      .then((s) => snapshots.push(s))
      .catch(() => {})
      .finally(() => {
        snapping = false
      })
  }, 3_000 * SCALE)

  // narrate the events the dashboard shows, and record them as the site's replay fixture
  const narrated = new Set([
    'session_opened',
    'challenge_blocked',
    'agent_killed',
    'kill_step',
    'session_closed',
    'sweep',
    'top_up',
    'batch_anchored',
    'float_sized',
  ])
  gw.bus.subscribe((e: GatewayEvent) => {
    const line = JSON.stringify({ ...e, t: Date.now() - t0 }, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    )
    appendFileSync(eventsFile, `${line}\n`)
    replayEvents.push(JSON.parse(line))
    if (narrated.has(e.type))
      say('tabula', `${e.message}${e.explorerUrl ? `\n${' '.repeat(21)}${e.explorerUrl}` : ''}`)
    if (e.type === 'voucher' && (e.data as { row?: { verdict?: string } }).row?.verdict === 'blocked')
      say('tabula', e.message)
  })

  const log = (id: string, msg: string) => say(id, msg)
  const research = new DemoAgent({
    id: 'research-01',
    apiKey: keys['research-01']!,
    gatewayUrl,
    vendorId: 'inference-a',
    taskType: 'summarize',
    intervalMs: 1500,
    callsPerTask: 6,
    maxCallsPerTask: 12,
    prompts: RESEARCH_PROMPTS,
    log,
  })
  const coder = new DemoAgent({
    id: 'coder-01',
    apiKey: keys['coder-01']!,
    gatewayUrl,
    vendorId: 'inference-b',
    taskType: 'summarize',
    intervalMs: 800,
    callsPerTask: 6,
    maxCallsPerTask: 12,
    prompts: CODING_PROMPTS,
    log,
  })
  const rogue = new DemoAgent({
    id: 'rogue-01',
    apiKey: keys['rogue-01']!,
    gatewayUrl,
    vendorId: 'inference-b',
    taskType: 'summarize',
    intervalMs: 2500,
    callsPerTask: 6,
    maxCallsPerTask: 12,
    prompts: TICKET_PROMPTS,
    log,
  })
  for (const a of [research, coder, rogue]) a.start()

  await sleepUntil(25)
  say('coder-01', `reads a web page: "${POISONED_PAGE}"`)
  const mirror = await coder.session('inference-a', { endpoint: 'http://127.0.0.1:4803/v1/infer' })
  if (mirror) throw new Error('the mirror should have been blocked')
  say('coder-01', 'falls back to the registered inference-a endpoint')
  coder.vendorId = 'inference-a'

  await sleepUntil(45)
  say('rogue-01', `receives ticket: "${INJECTED_TICKET}"`)
  rogue.intervalMs = 0
  const killDeadline = Date.now() + 60_000
  while (!rogue.stopped && Date.now() < killDeadline) await new Promise((r) => setTimeout(r, 250))
  say('demo', `${research.cfg.id} and ${coder.cfg.id} keep working, untouched`)

  await sleepUntil(120)
  say('demo', 'float manager: sweeping channels idle for more than 60s')
  const swept = await gw.sessions.sweepIdle(config.idleAfterMs)
  say('demo', `reclaimed ${formatUsd(BigInt(swept.reclaimed))} of idle escrow and float`)

  await sleepUntil(150)
  say('demo', 'stopping the agents and closing their channels')
  await Promise.all([research.stop(), coder.stop(), rogue.stop()])
  for (const agent of [research, coder]) {
    for (const s of agent.sessions.values()) {
      const r = await agent.client.closeSession(s.sessionId)
      if (!r.ok) say(agent.cfg.id, `close failed: ${String(r.body.message ?? r.status)}`)
    }
  }
  await gw.sessions.sweepIdle(0) // return every agent's leftover float to the vault

  console.log('\n--- onchain receipts')
  await gw.anchorer.anchorAll()
  const batchDetails: Record<string, unknown> = {}
  for (const b of await gw.ledger.db.select().from(schema.batches)) {
    const v = await gw.anchorer.verify(b.id)
    batchDetails[b.id] = { rows: await gw.anchorer.batchRows(b.id), verification: v }
    console.log(
      `${v.match ? 'MATCH   ' : 'MISMATCH'} batch ${b.id}: ${v.voucherCount} vouchers, root ${v.recomputedRoot.slice(0, 16)}…  ${v.explorerUrl}`,
    )
  }

  console.log('\n--- reconciliation (ledger vs onchain settlement)')
  const reconciled = await reconcileAll(gw.ledger.db, gw.rpc, config.cluster)
  for (const r of reconciled) {
    console.log(
      `${r.status.padEnd(14)} ${r.agentId.padEnd(12)} ${r.vendorId.padEnd(12)} signed ${formatUsd(BigInt(r.ledgerSigned)).padEnd(10)} settled ${formatUsd(BigInt(r.settled)).padEnd(10)} ${r.explanation}`,
    )
  }

  console.log('\n--- vendor scorecards (from this run)')
  for (const s of await scorecards(gw.ledger.db)) {
    console.log(
      `${s.vendorId.padEnd(12)} ${String(s.completedTasks).padStart(3)} tasks  cost/task ${s.costPerCompletedTask === null ? 'n/a' : formatUsd(BigInt(s.costPerCompletedTask))}  waste ${s.wastePct}%  p95 ${s.p95LatencyMs}ms${s.cheaperOption ? `  -> ${s.cheaperOption.vendorId} does the same task ${s.cheaperOption.savingsPct}% cheaper` : ''}`,
    )
  }

  const csvFile = join(dataDir, 'demo-ledger.csv')
  writeFileSync(csvFile, await exportCsv(gw.ledger.db, config.cluster))
  const vaultEnd = (await gw.treasury.vaultBalance()) ?? 0n
  const o = await gw.ledger.db.select().from(schema.vouchers)
  console.log(`\n--- summary`)
  console.log(
    `vouchers: ${o.filter((v) => v.verdict === 'signed').length} signed, ${o.filter((v) => v.verdict === 'blocked').length} blocked`,
  )
  const settledTotal = reconciled.reduce((acc, r) => acc + BigInt(r.settled), 0n)
  console.log(
    `vault: ${formatUsd(vaultStart)} -> ${formatUsd(vaultEnd)} (down ${formatUsd(vaultStart - vaultEnd)}; vendors settled ${formatUsd(settledTotal)} onchain: ${vaultStart - vaultEnd === settledTotal ? 'exact' : 'DIFFERS'})`,
  )
  console.log(`ledger CSV: ${csvFile}\nreplay events: ${eventsFile}\nledger DB: ${config.dbPath}`)

  // the hosted dashboard replays this run without a gateway (public data only: no keys)
  clearInterval(snapTimer)
  while (snapping) await new Promise((r) => setTimeout(r, 100))
  snapshots.push(await snapshot())
  const replay = {
    meta: {
      cluster: config.cluster.name,
      rpcUrl: config.cluster.rpcUrl,
      recordedAt: new Date(t0).toISOString(),
      durationMs: Date.now() - t0,
      vault: gw.treasury.vaultAddress,
      vaultStart: vaultStart.toString(),
      vaultEnd: vaultEnd.toString(),
      timeScale: SCALE,
    },
    events: replayEvents,
    snapshots,
    final: {
      vouchers: await get('/v1/vouchers?limit=5000'),
      events: await get('/v1/events?limit=2000'),
      batchDetails,
    },
  }
  const replayJson = JSON.stringify(replay)
  writeFileSync(join(dataDir, 'replay.json'), replayJson)
  const webReplay = join(dirname(dataDir), 'apps', 'web', 'public', 'replay', 'demo.json')
  mkdirSync(dirname(webReplay), { recursive: true })
  writeFileSync(webReplay, replayJson)
  console.log(`replay fixture: ${webReplay} (${Math.round(replayJson.length / 1024)} KB)`)

  if (HOLD) {
    console.log(`\nHolding: gateway ${gatewayUrl} and vendors stay up. Ctrl+C to exit.`)
    return
  }
  await app.close()
  await gw.close()
  for (const v of vendors) await v.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
