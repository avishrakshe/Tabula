import { address } from '@solana/kit'
import { type Ledger, openLedger } from '@tabula/ledger'
import { createRpc, type SolanaRpc, vaultFor } from '@tabula/solana'
import { Anchorer } from './anchor.js'
import type { GatewayConfig } from './config.js'
import { Custody, GuardedVoucherSigner } from './custody.js'
import { EventBus } from './events.js'
import { PolicyService } from './policy-service.js'
import { SessionManager } from './sessions.js'
import { Store } from './store.js'
import { CeilingTreasury, FaucetTreasury, loadTreasuryState, type Treasury } from './treasury.js'

export interface Gateway {
  readonly config: GatewayConfig
  readonly ledger: Ledger
  readonly store: Store
  readonly bus: EventBus
  readonly custody: Custody
  readonly signer: GuardedVoucherSigner
  readonly policy: PolicyService
  readonly treasury: Treasury
  readonly sessions: SessionManager
  readonly anchorer: Anchorer
  readonly rpc: SolanaRpc
  close(): Promise<void>
}

/** The Squads-vault treasury when `pnpm setup` has created one for this cluster; otherwise the sandbox faucet. */
export function defaultTreasury(config: GatewayConfig, rpc: SolanaRpc, custody: Custody): Treasury {
  const state = loadTreasuryState(config.treasuryFile)
  if (
    state &&
    state.cluster === config.cluster.name &&
    state.rpcUrl === config.cluster.rpcUrl &&
    state.mint === config.mint
  ) {
    return new CeilingTreasury(
      rpc,
      address(config.mint),
      vaultFor(address(state.multisig), state.vaultIndex),
      custody,
    )
  }
  if (config.cluster.cheatcodes) return new FaucetTreasury(config.cluster, rpc, address(config.mint))
  throw new Error(`no treasury for ${config.cluster.name}: run pnpm setup first`)
}

export async function createGateway(
  config: GatewayConfig,
  opts: { treasury?: (rpc: SolanaRpc, custody: Custody) => Treasury | Promise<Treasury> } = {},
): Promise<Gateway> {
  const ledger = await openLedger(config.dbPath)
  const rpc = createRpc(config.cluster.rpcUrl)
  const store = new Store(ledger.db)
  const bus = new EventBus(ledger.db)
  const custody = await Custody.load()
  const signer = new GuardedVoucherSigner(custody)
  const policy = new PolicyService(ledger.db, bus)
  await policy.load()
  signer.setGlobalKill(policy.globalKill)
  for (const a of await store.agents()) if (a.status === 'killed') signer.markKilled(a.id)
  const treasury = opts.treasury ? await opts.treasury(rpc, custody) : defaultTreasury(config, rpc, custody)
  const sessions = new SessionManager(config, rpc, store, custody, signer, policy, treasury, bus)
  // a long-running gateway rebuilds its sessions and settles calls cut off by its last stop; serverless
  // instances load sessions on demand and leave dangling calls to the sweep (others may still be in flight)
  if (!config.serverless) await sessions.restore()
  const anchorer = new Anchorer(ledger.db, rpc, config.cluster, custody.operator, bus)

  // anchor a batch every `anchorEvery` ledger rows (the periodic timer lives in main.ts)
  const inflight = new Set<Promise<unknown>>()
  let sinceAnchor = 0
  const unsubscribe = bus.subscribe((e) => {
    if (e.type !== 'voucher' || config.anchorEvery <= 0) return
    if (++sinceAnchor < config.anchorEvery) return
    sinceAnchor = 0
    const p = anchorer
      .anchorNext(Math.max(1, Math.floor(config.anchorEvery / 2)))
      .catch((err) => console.error('[gateway] anchoring failed:', (err as Error).message))
    inflight.add(p)
    void p.finally(() => inflight.delete(p))
  })

  return {
    config,
    ledger,
    store,
    bus,
    custody,
    signer,
    policy,
    treasury,
    sessions,
    anchorer,
    rpc,
    close: async () => {
      unsubscribe()
      await sessions.drain()
      await Promise.allSettled([...inflight])
      await ledger.close()
    },
  }
}
