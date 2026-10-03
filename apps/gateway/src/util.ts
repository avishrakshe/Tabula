import { createHash, randomBytes } from 'node:crypto'

/** Per-key FIFO mutex: work for one key runs strictly in order; different keys run concurrently. */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<unknown>>()

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const tail = prev.then(() => gate)
    this.#tails.set(key, tail)
    await prev.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    }
  }
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`
}

export function newApiKey(): string {
  return `tab_${randomBytes(24).toString('base64url')}`
}

export function toNum(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`amount ${v} exceeds safe integer range`)
  }
  return Number(v)
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

export async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new TimeoutError(ms)), ms)
  try {
    return await fn(ctrl.signal)
  } catch (err) {
    if (ctrl.signal.aborted) throw new TimeoutError(ms)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
