import { address } from '@solana/kit'
import { type Ledger, openLedger } from '@tabula/ledger'
import { createRpc, type SolanaRpc, vaultFor } from '@tabula/solana'
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
  await sessions.restore()
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
    rpc,
    close: async () => {
      await sessions.drain()
      ledger.close()
    },
  }
}
