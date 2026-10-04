/**
 * Sorted-pair SHA-256 Merkle tree (browser-safe, no Node APIs).
 *
 *   leaf    = sha256(0x00 || utf8(canonical(row)))
 *   parent  = sha256(0x01 || min(a, b) || max(a, b))      (bytewise order)
 *   odd node at the end of a level is carried up unchanged
 *   root of zero leaves is undefined (a batch always has at least one row)
 *
 * Sorting pairs means a proof is just the list of sibling hashes, with no left/right flags. The
 * 0x00/0x01 domain tags stop a leaf from being reinterpreted as an inner node.
 */
import { sha256 } from '@noble/hashes/sha2.js'
// extensionless on purpose: this module is also bundled into the dashboard by Turbopack,
// which does not map `.js` specifiers to `.ts` sources in workspace packages
import { canonicalize } from './canonical'

const LEAF = Uint8Array.of(0x00)
const NODE = Uint8Array.of(0x01)
const enc = new TextEncoder()

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!
  }
  return a.length - b.length
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('invalid hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function hashLeaf(row: unknown): Uint8Array {
  return sha256(concat(LEAF, enc.encode(canonicalize(row))))
}

export function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  return compare(a, b) <= 0 ? sha256(concat(NODE, a, b)) : sha256(concat(NODE, b, a))
}

/** Every level of the tree, leaves first, root last. */
export function buildLevels(leaves: readonly Uint8Array[]): Uint8Array[][] {
  if (leaves.length === 0) throw new Error('cannot build a Merkle tree with no leaves')
  const levels: Uint8Array[][] = [[...leaves]]
  while (levels[levels.length - 1]!.length > 1) {
    const prev = levels[levels.length - 1]!
    const next: Uint8Array[] = []
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i]!, prev[i + 1]!) : prev[i]!)
    }
    levels.push(next)
  }
  return levels
}

export function merkleRoot(rows: readonly unknown[]): string {
  const levels = buildLevels(rows.map(hashLeaf))
  return toHex(levels[levels.length - 1]![0]!)
}

/** Sibling hashes from leaf `index` up to the root (skipping levels where the node had no sibling). */
export function merkleProof(rows: readonly unknown[], index: number): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= rows.length)
    throw new RangeError('leaf index out of range')
  const levels = buildLevels(rows.map(hashLeaf))
  const proof: string[] = []
  let i = index
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l]!
    const sibling = i % 2 === 0 ? i + 1 : i - 1
    if (sibling < level.length) proof.push(toHex(level[sibling]!))
    i = Math.floor(i / 2)
  }
  return proof
}

export function verifyProof(row: unknown, proof: readonly string[], rootHex: string): boolean {
  let h = hashLeaf(row)
  for (const s of proof) h = hashPair(h, fromHex(s))
  return toHex(h) === rootHex.toLowerCase()
}
