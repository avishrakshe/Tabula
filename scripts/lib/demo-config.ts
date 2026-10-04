/** Agents, policies and vendor registry shared by `pnpm setup` and `pnpm demo`. */
import { address } from '@solana/kit'
import { type AgentSpec, type Gateway, registerVendor } from '@tabula/gateway'
import { loadOrCreateKeypair } from '@tabula/solana'
import { DEMO_VENDORS } from '@tabula/vendor-mock'

export const GLOBAL_POLICY = {
  vendors: { allow: ['inference-a', 'inference-b'] },
  maxUnitPriceUsd: 0.00001,
  onViolation: 'kill_and_close' as const,
}

/**
 * Daily budgets double as each agent's onchain allowance (per day, pulled from the vault).
 * rogue-01's normal pace (one call every 2.5s on inference-b, ~$0.03/min) sits at half its
 * velocity limit; after the injected ticket it calls as fast as the vendor answers and trips.
 */
export const DEMO_AGENTS: AgentSpec[] = [
  {
    id: 'research-01',
    name: 'Research agent',
    role: 'Summarises papers for the research team',
    department: 'Research',
    dailyBudget: 5_000_000,
    policy: { dailyBudgetUsd: 5, perTaskBudgetUsd: 2, velocity: { windowSec: 60, maxUsd: 0.2 } },
  },
  {
    id: 'coder-01',
    name: 'Coding agent',
    role: 'Writes and reviews code',
    department: 'Engineering',
    dailyBudget: 5_000_000,
    policy: { dailyBudgetUsd: 5, perTaskBudgetUsd: 2, velocity: { windowSec: 60, maxUsd: 0.2 } },
  },
  {
    id: 'rogue-01',
    name: 'Support triage agent',
    role: 'Reads inbound support tickets (the one that gets prompt-injected)',
    department: 'Support',
    dailyBudget: 5_000_000,
    policy: { dailyBudgetUsd: 5, perTaskBudgetUsd: 2, velocity: { windowSec: 60, maxUsd: 0.06 } },
  },
]

/** Registers the demo vendors (not the malicious mirror) with their payees from keys/. */
export async function registerDemoVendors(gw: Gateway): Promise<{ id: string; payee: string }[]> {
  const out = []
  for (const v of DEMO_VENDORS.filter((x) => x.id !== 'mirror')) {
    const payee = await loadOrCreateKeypair(v.payeeKey)
    await registerVendor(gw, {
      id: v.id,
      name: v.name,
      endpoint: `http://127.0.0.1:${v.port}/v1/infer`,
      payeePubkey: payee.address,
      mint: address(gw.config.mint),
      programId: gw.config.cluster.paymentChannelsProgram,
      unitName: v.unitName,
      unitPrice: Number(v.unitPrice),
      maxUnitPrice: Number(v.unitPrice) * 2,
      taskType: v.taskType,
    })
    out.push({ id: v.id, payee: payee.address })
  }
  return out
}
