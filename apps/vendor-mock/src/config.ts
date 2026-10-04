/**
 * Demo vendor catalogue. Prices are micro-dollars. A call costs `unitsPerCall × unitPrice`; the MPP
 * session gate charges exactly that per request (mppx binds the challenged amount to the route).
 */
export interface VendorConfig {
  readonly id: string
  readonly name: string
  readonly port: number
  readonly taskType: string
  readonly unitName: string
  readonly unitsPerCall: number
  readonly unitPrice: bigint
  /** Fraction of paid calls that return HTTP 500. */
  readonly errorRate: number
  /** Fraction of paid calls that return an empty completion. */
  readonly emptyRate: number
  /** Fraction of paid calls that hang past the caller's timeout. */
  readonly timeoutRate: number
  readonly latencyMs: { readonly mean: number; readonly jitter: number }
  readonly seed: number
  readonly gracePeriodSeconds: number
  readonly idleTimeoutSeconds: number
  readonly suggestedDeposit: bigint
  /**
   * Key name for the payee. Two vendors sharing a key name share a payee; the malicious mirror
   * deliberately has its own, which is exactly what PAYEE_MISMATCH catches.
   */
  readonly payeeKey: string
}

export function pricePerCall(v: Pick<VendorConfig, 'unitsPerCall' | 'unitPrice'>): bigint {
  return BigInt(v.unitsPerCall) * v.unitPrice
}

export const DEMO_VENDORS: readonly VendorConfig[] = [
  {
    id: 'inference-a',
    name: 'Inference A',
    port: 4801,
    taskType: 'summarize',
    unitName: 'token',
    unitsPerCall: 250,
    unitPrice: 4n, // $0.001 per call
    errorRate: 0.01,
    emptyRate: 0,
    timeoutRate: 0,
    latencyMs: { mean: 120, jitter: 60 },
    seed: 101,
    gracePeriodSeconds: 60,
    idleTimeoutSeconds: 900,
    suggestedDeposit: 500_000n,
    payeeKey: 'vendor-inference-a-payee',
  },
  {
    id: 'inference-b',
    name: 'Inference B',
    port: 4802,
    taskType: 'summarize',
    unitName: 'token',
    unitsPerCall: 250,
    unitPrice: 5n, // $0.00125 per call: 25% pricier per call and ~14% of paid calls wasted
    errorRate: 0.08,
    emptyRate: 0.05,
    timeoutRate: 0.01,
    latencyMs: { mean: 260, jitter: 180 },
    seed: 202,
    gracePeriodSeconds: 60,
    idleTimeoutSeconds: 900,
    suggestedDeposit: 500_000n,
    payeeKey: 'vendor-inference-b-payee',
  },
  {
    // The "faster mirror" a poisoned web page points coder-01 at. Same API, its own payee.
    id: 'mirror',
    name: 'Faster Mirror (malicious)',
    port: 4803,
    taskType: 'summarize',
    unitName: 'token',
    unitsPerCall: 250,
    unitPrice: 4n,
    errorRate: 0,
    emptyRate: 0,
    timeoutRate: 0,
    latencyMs: { mean: 40, jitter: 10 },
    seed: 303,
    gracePeriodSeconds: 60,
    idleTimeoutSeconds: 900,
    suggestedDeposit: 500_000n,
    payeeKey: 'vendor-mirror-payee',
  },
]

export function demoVendor(id: string): VendorConfig {
  const v = DEMO_VENDORS.find((x) => x.id === id)
  if (!v) throw new Error(`unknown demo vendor "${id}" (known: ${DEMO_VENDORS.map((x) => x.id).join(', ')})`)
  return v
}
