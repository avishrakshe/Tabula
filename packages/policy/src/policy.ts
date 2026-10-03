import { usdToMicros } from './money.js'

/** What the gateway does when a rule trips. `block` refuses one voucher; the others also stop the agent. */
export type ViolationAction = 'block' | 'pause' | 'kill_and_close'

/** Policy as authored (JSON, USD floats). Every field is optional; absent means "no limit from this scope". */
export interface PolicyDoc {
  readonly agent?: string
  readonly dailyBudgetUsd?: number
  readonly perTaskBudgetUsd?: number
  readonly velocity?: VelocityDoc | readonly VelocityDoc[]
  readonly maxUnitPriceUsd?: number
  readonly vendors?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }
  readonly anomaly?: { readonly zScore: number; readonly minSamples: number; readonly bucketSec?: number }
  readonly onViolation?: ViolationAction
}

export interface VelocityDoc {
  readonly windowSec: number
  readonly maxUsd: number
}

export interface VelocityRule {
  readonly windowMs: number
  readonly max: bigint
}

export interface AnomalyRule {
  readonly zScore: number
  readonly minSamples: number
  readonly bucketMs: number
}

/** Compiled policy: integer micros, sets, normalized windows. */
export interface Policy {
  readonly dailyBudget: bigint | null
  readonly perTaskBudget: bigint | null
  readonly velocity: readonly VelocityRule[]
  readonly maxUnitPrice: bigint | null
  /** `null` = any vendor not denied. An empty set allows nothing. */
  readonly vendorAllow: ReadonlySet<string> | null
  readonly vendorDeny: ReadonlySet<string>
  readonly anomaly: AnomalyRule | null
  readonly onViolation: ViolationAction
}

export const DEFAULT_ANOMALY_BUCKET_SEC = 10

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyValidationError'
  }
}

function nonNegativeUsd(field: string, v: number | undefined): bigint | null {
  if (v === undefined) return null
  if (!Number.isFinite(v) || v < 0) throw new PolicyValidationError(`${field} must be a non-negative number`)
  return usdToMicros(v)
}

function positiveInt(field: string, v: number): number {
  if (!Number.isInteger(v) || v <= 0) throw new PolicyValidationError(`${field} must be a positive integer`)
  return v
}

export function compilePolicy(doc: PolicyDoc): Policy {
  const velocityDocs =
    doc.velocity === undefined ? [] : Array.isArray(doc.velocity) ? doc.velocity : [doc.velocity]
  const velocity = (velocityDocs as readonly VelocityDoc[]).map((v, i) => ({
    windowMs: positiveInt(`velocity[${i}].windowSec`, v.windowSec) * 1000,
    max: nonNegativeUsd(`velocity[${i}].maxUsd`, v.maxUsd) as bigint,
  }))
  let anomaly: AnomalyRule | null = null
  if (doc.anomaly) {
    if (!Number.isFinite(doc.anomaly.zScore) || doc.anomaly.zScore <= 0) {
      throw new PolicyValidationError('anomaly.zScore must be a positive number')
    }
    anomaly = {
      zScore: doc.anomaly.zScore,
      minSamples: positiveInt('anomaly.minSamples', doc.anomaly.minSamples),
      bucketMs: positiveInt('anomaly.bucketSec', doc.anomaly.bucketSec ?? DEFAULT_ANOMALY_BUCKET_SEC) * 1000,
    }
  }
  const onViolation = doc.onViolation ?? 'kill_and_close'
  if (!['block', 'pause', 'kill_and_close'].includes(onViolation)) {
    throw new PolicyValidationError(`onViolation must be block, pause or kill_and_close`)
  }
  return {
    dailyBudget: nonNegativeUsd('dailyBudgetUsd', doc.dailyBudgetUsd),
    perTaskBudget: nonNegativeUsd('perTaskBudgetUsd', doc.perTaskBudgetUsd),
    velocity,
    maxUnitPrice: nonNegativeUsd('maxUnitPriceUsd', doc.maxUnitPriceUsd),
    vendorAllow: doc.vendors?.allow ? new Set(doc.vendors.allow) : null,
    vendorDeny: new Set(doc.vendors?.deny ?? []),
    anomaly,
    onViolation,
  }
}

const SEVERITY: Record<ViolationAction, number> = { block: 0, pause: 1, kill_and_close: 2 }

function minNullable(a: bigint | null, b: bigint | null): bigint | null {
  if (a === null) return b
  if (b === null) return a
  return a < b ? a : b
}

/**
 * Combines scopes (global, agent, vendor) into one effective policy: the strictest of each limit,
 * the intersection of allowlists, the union of denylists, every velocity window, the most
 * sensitive anomaly rule and the most severe violation action.
 */
export function mergePolicies(...policies: readonly Policy[]): Policy {
  return policies.reduce<Policy>((acc, p) => {
    let vendorAllow: ReadonlySet<string> | null
    if (acc.vendorAllow === null) vendorAllow = p.vendorAllow
    else if (p.vendorAllow === null) vendorAllow = acc.vendorAllow
    else vendorAllow = new Set([...acc.vendorAllow].filter((v) => p.vendorAllow?.has(v)))
    let anomaly: AnomalyRule | null
    if (acc.anomaly === null) anomaly = p.anomaly
    else if (p.anomaly === null) anomaly = acc.anomaly
    else anomaly = p.anomaly.zScore < acc.anomaly.zScore ? p.anomaly : acc.anomaly
    return {
      dailyBudget: minNullable(acc.dailyBudget, p.dailyBudget),
      perTaskBudget: minNullable(acc.perTaskBudget, p.perTaskBudget),
      velocity: [...acc.velocity, ...p.velocity],
      maxUnitPrice: minNullable(acc.maxUnitPrice, p.maxUnitPrice),
      vendorAllow,
      vendorDeny: new Set([...acc.vendorDeny, ...p.vendorDeny]),
      anomaly,
      onViolation: SEVERITY[p.onViolation] > SEVERITY[acc.onViolation] ? p.onViolation : acc.onViolation,
    }
  }, EMPTY_POLICY)
}

/** The identity for `mergePolicies`: no limits, least severe action. */
export const EMPTY_POLICY: Policy = {
  dailyBudget: null,
  perTaskBudget: null,
  velocity: [],
  maxUnitPrice: null,
  vendorAllow: null,
  vendorDeny: new Set(),
  anomaly: null,
  onViolation: 'block',
}
