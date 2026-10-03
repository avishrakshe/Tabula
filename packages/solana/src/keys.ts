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

/** Loads `keys/<name>.json`, creating it with a fresh keypair if missing. */
export async function loadOrCreateKeypair(name: string): Promise<KeyPairSigner> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`invalid key name: ${name}`)
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
