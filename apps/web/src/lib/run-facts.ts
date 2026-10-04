/**
 * Numbers for the landing page, read at build time from the recorded demo run
 * (public/replay/demo.json). Nothing on the page is typed in by hand: re-record, rebuild.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReplayFile } from './data/replay'

export interface RunFacts {
  recordedAt: string
  durationSec: number
  cluster: string
  signed: number
  blocked: number
  kill: {
    agentId: string
    reason: string
    /** this agent's vouchers up to and including the blocked one */
    voucherNumber: number
    /** seconds from the prompt injection to the kill */
    afterInjectionSec: number
    settled: number
    refunded: number
  }
  payee: { agentId: string; vendorId: string; offered: string; expected: string }
  idleSweep: { refunded: number; agentId: string; vendorId: string }
  channels: { total: number; matched: number }
  batches: { total: number; matched: number }
  vault: { start: number; end: number; settled: number }
  allowancePerDay: number
  scores: {
    vendorId: string
    wastePct: number
    costPerTask: number | null
    cheaper: string | null
    savingsPct: number | null
  }[]
}

/** The demo injects the rogue agent's ticket at t=45s (scripts/demo.ts). */
const INJECTION_MS = 45_000

let cached: RunFacts | null = null

export function runFacts(): RunFacts {
  if (cached) return cached
  const file = JSON.parse(
    readFileSync(join(process.cwd(), 'public', 'replay', 'demo.json'), 'utf8'),
  ) as ReplayFile
  const last = file.snapshots[file.snapshots.length - 1]!
  const vouchers = file.final.vouchers
  const blockedRow = vouchers.find((v) => v.verdict === 'blocked')!
  const killEvent = file.events.find((e) => e.type === 'agent_killed')!
  const challenge = file.events.find((e) => e.type === 'challenge_blocked')!
  const cdata = challenge.data as { vendorId: string; payeeOffered: string; payeeExpected: string }
  const killedRow = last.reconcile.find((r) => r.agentId === blockedRow.agentId)!
  // the float manager's idle sweep: the channel closed between the 2:00 sweep and the final close-out
  const idleClose = file.events.find(
    (e) => e.type === 'session_closed' && (e.t ?? 0) >= 120_000 && (e.t ?? 0) < 150_000,
  )!
  const idleSession = (idleClose.data as { sessionId: string; refunded: string }).sessionId
  const idleRow = last.reconcile.find((r) => r.sessionId === idleSession)!
  const batches = Object.values(file.final.batchDetails)

  cached = {
    recordedAt: file.meta.recordedAt,
    durationSec: Math.round(file.meta.durationMs / 1000),
    cluster: file.meta.cluster,
    signed: vouchers.filter((v) => v.verdict === 'signed').length,
    blocked: vouchers.filter((v) => v.verdict === 'blocked').length,
    kill: {
      agentId: blockedRow.agentId,
      reason: blockedRow.reason ?? '',
      voucherNumber: vouchers.filter((v) => v.agentId === blockedRow.agentId && v.id <= blockedRow.id).length,
      afterInjectionSec: Math.round(((killEvent.t ?? 0) - INJECTION_MS) / 1000),
      settled: Number(killedRow.settled),
      refunded: Number(killedRow.refundDue),
    },
    payee: {
      agentId: challenge.agentId ?? '',
      vendorId: cdata.vendorId,
      offered: cdata.payeeOffered,
      expected: cdata.payeeExpected,
    },
    idleSweep: {
      refunded: Number((idleClose.data as { refunded: string }).refunded),
      agentId: idleRow.agentId,
      vendorId: idleRow.vendorId,
    },
    channels: {
      total: last.reconcile.length,
      matched: last.reconcile.filter((r) => r.status === 'MATCHED').length,
    },
    batches: { total: batches.length, matched: batches.filter((b) => b.verification.match).length },
    vault: {
      start: Number(file.meta.vaultStart),
      end: Number(file.meta.vaultEnd),
      settled: last.reconcile.reduce((s, r) => s + Number(r.settled), 0),
    },
    allowancePerDay: Number(last.agents[0]?.allowance?.perPeriod ?? 0),
    scores: last.scores.map((s) => ({
      vendorId: s.vendorId,
      wastePct: s.wastePct,
      costPerTask: s.costPerCompletedTask,
      cheaper: s.cheaperOption?.vendorId ?? null,
      savingsPct: s.cheaperOption?.savingsPct ?? null,
    })),
  }
  return cached
}
