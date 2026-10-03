/**
 * All amounts inside the engine are integer micro-dollars (USDC base units, 6 decimals) as `bigint`.
 * Floats only appear at the edges: the human-authored policy JSON and plain-language formatting.
 */
export const MICROS_PER_USD = 1_000_000n

/** Converts a USD amount (as authored in policy JSON) to integer micros, rounding half away from zero. */
export function usdToMicros(usd: number): bigint {
  if (!Number.isFinite(usd)) throw new RangeError(`not a finite USD amount: ${usd}`)
  return BigInt(Math.round(usd * 1_000_000))
}

/** Formats micros as `$1.23`, keeping sub-cent precision only when needed (`$0.0004`). */
export function formatUsd(micros: bigint): string {
  const negative = micros < 0n
  const abs = negative ? -micros : micros
  const whole = abs / MICROS_PER_USD
  const frac = (abs % MICROS_PER_USD).toString().padStart(6, '0')
  let shown = frac.slice(0, 2)
  const rest = frac.slice(2).replace(/0+$/, '')
  if (rest.length > 0) shown = `${shown}${rest}`
  return `${negative ? '-' : ''}$${whole.toString()}.${shown}`
}
