/**
 * Registers agents (with fresh API keys and Tabula-held wallets), the vendor registry and policies.
 * Used by scripts/setup-devnet.ts and the tests. Idempotent per agent/vendor id; API keys are only
 * returned when an agent is first created (only their hash is stored).
 */

import { schema } from '@tabula/ledger'
import { eq } from '@tabula/ledger/sql'
import type { PolicyDoc } from '@tabula/policy'
import type { Gateway } from './gateway.js'
import { newApiKey, sha256Hex } from './util.js'

export interface AgentSpec {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly department: string
  readonly dailyBudget: number
  readonly policy?: PolicyDoc
}

export interface VendorSpec {
  readonly id: string
  readonly name: string
  readonly endpoint: string
  readonly payeePubkey: string
  readonly mint: string
  readonly programId: string
  readonly unitName: string
  readonly unitPrice: number
  readonly maxUnitPrice: number
  readonly taskType: string
  readonly allowlisted?: boolean
}

export async function registerAgent(gw: Gateway, spec: AgentSpec, apiKey?: string): Promise<string | null> {
  const existing = await gw.store.agent(spec.id)
  const keys = await gw.custody.agentKeys(spec.id)
  let key: string | null = null
  if (!existing) {
    key = apiKey ?? newApiKey()
    await gw.ledger.db.insert(schema.agents).values({
      id: spec.id,
      name: spec.name,
      role: spec.role,
      department: spec.department,
      apiKeyHash: sha256Hex(key),
      payerPubkey: keys.payer.address,
      voucherPubkey: keys.voucher.address,
      dailyBudget: spec.dailyBudget,
      status: 'active',
      createdAt: Date.now(),
    })
  } else if (apiKey) {
    await gw.ledger.db
      .update(schema.agents)
      .set({ apiKeyHash: sha256Hex(apiKey) })
      .where(eq(schema.agents.id, spec.id))
    key = apiKey
  }
  if (spec.policy) await gw.policy.setPolicy('agent', spec.id, spec.policy, 'setup')
  return key
}

export async function registerVendor(gw: Gateway, spec: VendorSpec): Promise<void> {
  const row = { ...spec, allowlisted: spec.allowlisted ?? true }
  await gw.ledger.db
    .insert(schema.vendors)
    .values(row)
    .onConflictDoUpdate({ target: schema.vendors.id, set: row })
}
