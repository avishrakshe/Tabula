import type { Address, KeyPairSigner } from '@solana/kit'
import { type ClusterConfig, ownerTokenBalance, type SolanaRpc, setTokenBalance } from '@tabula/solana'

export interface FundingResult {
  /** Amount moved into the agent wallet (0 when it already had enough). */
  readonly moved: bigint
  readonly source: string
  readonly txSignature?: string
}

/**
 * Where agent wallets get their escrow money and where unused money goes back. M2 ships the
 * sandbox faucet; M3 adds the onchain-ceiling treasury (Squads vault + per-agent allowance).
 */
export interface Treasury {
  readonly kind: string
  ensureFunded(agentId: string, payer: KeyPairSigner, amount: bigint): Promise<FundingResult>
  /** Remaining onchain allowance for the agent, or null when no onchain ceiling is configured. */
  remainingCeiling(agentId: string): Promise<bigint | null>
  /** Moves an agent wallet's idle balance back to the treasury. */
  sweep(agentId: string, payer: KeyPairSigner): Promise<{ amount: bigint; txSignature?: string }>
}

/** Sandbox/localnet only: tops agent wallets up with surfnet cheatcodes. No onchain ceiling. */
export class FaucetTreasury implements Treasury {
  readonly kind = 'sandbox-faucet'
  constructor(
    private readonly cluster: ClusterConfig,
    private readonly rpc: SolanaRpc,
    private readonly mint: Address,
    private readonly topUpTo: bigint = 5_000_000n,
  ) {
    if (!cluster.cheatcodes) throw new Error('FaucetTreasury needs a cheatcode cluster (sandbox or localnet)')
  }

  async ensureFunded(_agentId: string, payer: KeyPairSigner, amount: bigint): Promise<FundingResult> {
    const balance = await ownerTokenBalance(this.rpc, payer.address, this.mint)
    if (balance >= amount) return { moved: 0n, source: this.kind }
    const target = amount > this.topUpTo ? amount : this.topUpTo
    await setTokenBalance(this.cluster.rpcUrl, payer.address, this.mint, target)
    return { moved: target - balance, source: this.kind }
  }

  async remainingCeiling(): Promise<bigint | null> {
    return null
  }

  async sweep(): Promise<{ amount: bigint }> {
    return { amount: 0n }
  }
}
