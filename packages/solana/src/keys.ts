import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  type KeyPairSigner,
} from '@solana/kit'

/**
 * Demo keypairs live in the gitignored `keys/` folder at the repo root, in the same 64-byte JSON
 * array format as `solana-keygen` (32-byte seed followed by the 32-byte public key).
 * They are generated at runtime and never committed.
 */
export function keysDir(): string {
  if (process.env.TABULA_KEYS_DIR) return resolve(process.env.TABULA_KEYS_DIR)
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return join(dir, 'keys')
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return join(process.cwd(), 'keys')
}

export async function generateKeypairBytes(): Promise<Uint8Array> {
  const seed = crypto.getRandomValues(new Uint8Array(32))
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed)
  const out = new Uint8Array(64)
  out.set(seed, 0)
  out.set(getAddressEncoder().encode(signer.address), 32)
  return out
}

/**
 * Serverless deployments have no keys/ folder: with `TABULA_KEY_SEED` set (32 random bytes as 64 hex
 * characters, server-only), every named key is derived from it instead, as
 * HMAC-SHA256(seed, "tabula/v1/<name>"). One secret covers the operator, every agent's payer and voucher
 * keys and the hosted vendors, and a deployment can rebuild them all.
 */
function keySeed(): Buffer | null {
  const s = process.env.TABULA_KEY_SEED
  if (!s) return null
  if (!/^[0-9a-f]{64}$/i.test(s))
    throw new Error('TABULA_KEY_SEED must be 64 hex characters (32 random bytes)')
  return Buffer.from(s, 'hex')
}

const derived = new Map<string, Promise<KeyPairSigner>>()

/** The key `name` derived from `seed` (exported for tests; callers use `loadOrCreateKeypair`). */
export function deriveKeypair(seed: Uint8Array, name: string): Promise<KeyPairSigner> {
  const bytes = createHmac('sha256', seed).update(`tabula/v1/${name}`).digest()
  return createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(bytes))
}

/** Loads `keys/<name>.json`, creating it with a fresh keypair if missing (or derives it, see `keySeed`). */
export async function loadOrCreateKeypair(name: string): Promise<KeyPairSigner> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`invalid key name: ${name}`)
  const seed = keySeed()
  if (seed) {
    let k = derived.get(name)
    if (!k) {
      k = deriveKeypair(seed, name)
      derived.set(name, k)
    }
    return k
  }
  const dir = keysDir()
  const file = join(dir, `${name}.json`)
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(Array.from(await generateKeypairBytes())), { mode: 0o600 })
  }
  const bytes = Uint8Array.from(JSON.parse(readFileSync(file, 'utf8')) as number[])
  return createKeyPairSignerFromBytes(bytes)
}

/** A fresh in-memory keypair that is never written to disk. */
export async function ephemeralKeypair(): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(await generateKeypairBytes())
}
