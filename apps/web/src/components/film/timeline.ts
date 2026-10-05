/**
 * The Tabula film: a motion-graphic explainer drawn in code, a pure function of time. The site plays it
 * live (crisp at any size, a few kilobytes), and scripts/render-film.ts steps the same frames into an
 * MP4. The run's figures (the blocked voucher, refund, receipts, scorecards) come from the recorded
 * devnet run (FilmFacts), never typed in by hand; only "the threat", a run without Tabula, is drawn.
 */
import { usd } from '@/lib/format'

/** Amounts are micro-dollars, like the rest of the site. */
export interface FilmFacts {
  cluster: string
  signed: number
  kill: {
    agentId: string
    voucherNumber: number
    afterInjectionSec: number
    settled: number
    refunded: number
    spentInWindow: number
    windowSec: number
    limit: number
  }
  payee: { agentId: string; vendorId: string; offered: string; expected: string }
  anchor: { batchId: number; vouchers: number; root: string; tx: string } | null
  batches: { total: number; matched: number }
  channels: { total: number; matched: number }
  vaultDelta: number
  idleSwept: number
  idleAgent: string
  waste: { vendorId: string; pct: number; cheaper: string | null; savingsPct: number | null } | null
  allowancePerDay: number
  /** where the end card sends people, e.g. tabula-agents.vercel.app */
  host: string
}

export interface Chapter {
  id: string
  label: string
  start: number
  end: number
}

/** Scenes, in milliseconds. Each scene draws its own entrances and exits inside its window. */
export const CHAPTERS: Chapter[] = [
  { id: 'open', label: 'Tabula', start: 0, end: 5_600 },
  { id: 'shift', label: 'The shift', start: 5_600, end: 14_200 },
  { id: 'blind', label: 'The blind spot', start: 14_200, end: 22_400 },
  { id: 'threat', label: 'The threat', start: 22_400, end: 30_600 },
  { id: 'gate', label: 'Gate every voucher', start: 30_600, end: 40_000 },
  { id: 'stop', label: 'Stop a runaway agent', start: 40_000, end: 50_800 },
  { id: 'payee', label: 'Block swapped payees', start: 50_800, end: 58_000 },
  { id: 'prove', label: 'Prove every dollar', start: 58_000, end: 67_000 },
  { id: 'treasury', label: 'Treasury, not just guardrails', start: 67_000, end: 73_400 },
  { id: 'end', label: 'Get early access', start: 73_400, end: 81_000 },
]

export const DURATION = 81_000

/** A frame worth showing before anyone presses play: the gate, mid-flow. */
export const POSTER_T = 37_200

export function chapterAt(t: number): { chapter: Chapter; index: number } {
  const index = Math.max(
    0,
    CHAPTERS.findIndex((c) => t >= c.start && t < c.end),
  )
  return { chapter: CHAPTERS[t >= DURATION ? CHAPTERS.length - 1 : index]!, index }
}

export interface Caption {
  at: number
  to: number
  /** *starred* words are drawn in the accent colour */
  text: string
}

export function captions(f: FilmFacts): Caption[] {
  const k = f.kill
  return [
    {
      at: 6_000,
      to: 13_800,
      text: 'AI agents can now *pay per call:* thousands of signed vouchers, streamed through Solana payment channels.',
    },
    {
      at: 14_600,
      to: 22_000,
      text: 'But onchain you see just *two transactions.* Everything in between happens off the books.',
    },
    {
      at: 22_800,
      to: 30_200,
      text: 'One *prompt injection,* and an agent drains its escrow at machine speed.',
    },
    { at: 31_000, to: 35_200, text: '*Tabula* sits between your agents and the vendors they pay.' },
    {
      at: 35_400,
      to: 39_600,
      text: 'Agents get an API key. Tabula holds the keys, and *checks every voucher* before it is signed.',
    },
    { at: 40_400, to: 45_300, text: `${k.agentId} reads a poisoned support ticket and *speeds up.*` },
    {
      at: 45_500,
      to: 50_400,
      text: `Voucher #${k.voucherNumber} would cross the limit: *refused unsigned.* Agent stopped, ${usd(k.refunded)} swept home.`,
    },
    {
      at: 51_200,
      to: 57_600,
      text: 'A “faster mirror” names a different payee. *Blocked* before a single signature.',
    },
    {
      at: 58_400,
      to: 62_600,
      text: `Every ${f.anchor?.vouchers ?? 40} vouchers, a Merkle root is *anchored onchain.*`,
    },
    { at: 62_800, to: 66_600, text: 'Every channel *reconciles* against what actually settled.' },
    {
      at: 67_400,
      to: 73_000,
      text: 'Sweep idle escrow. Score your vendors. Keep a *hard ceiling* onchain.',
    },
    { at: 74_600, to: 80_600, text: `Live on Solana ${f.cluster} today. *Join the waitlist.*` },
  ]
}

// ---- easing ------------------------------------------------------------------------------------

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
/** 0 → 1 as t goes from a to b */
export const prog = (t: number, a: number, b: number) => clamp01((t - a) / (b - a))
export const lerp = (a: number, b: number, x: number) => a + (b - a) * x
export const easeOut = (x: number) => 1 - (1 - x) ** 3
export const easeIn = (x: number) => x ** 3
export const easeInOut = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2)
export const easeOutBack = (x: number) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2
}
/** 0 → 1 → 0: fades in over `fin` after a, out over `fout` before b */
export const win = (t: number, a: number, b: number, fin = 450, fout = 450) =>
  Math.min(easeOut(prog(t, a, a + fin)), 1 - easeIn(prog(t, b - fout, b)))
