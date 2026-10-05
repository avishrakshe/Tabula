import type { FilmFacts } from '@/components/film/timeline'
import { runFacts } from './run-facts'

/** The film's numbers, from the same recorded run as the rest of the landing page (server only). */
export function filmFacts(): FilmFacts {
  const f = runFacts()
  const lossy = f.scores.find((s) => s.cheaper) ?? null
  const site =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : null) ??
    'https://tabula-agents.vercel.app'
  return {
    cluster: f.cluster,
    signed: f.signed,
    kill: {
      agentId: f.kill.agentId,
      voucherNumber: f.kill.voucherNumber,
      afterInjectionSec: f.kill.afterInjectionSec,
      settled: f.kill.settled,
      refunded: f.kill.refunded,
      spentInWindow: f.kill.spentInWindow,
      windowSec: f.kill.windowSec,
      limit: f.kill.limit,
    },
    payee: f.payee,
    anchor: f.anchor,
    batches: f.batches,
    channels: f.channels,
    vaultDelta: f.vault.start - f.vault.end,
    idleSwept: f.idleSweep.refunded,
    idleAgent: f.idleSweep.agentId,
    waste: lossy
      ? {
          vendorId: lossy.vendorId,
          pct: lossy.wastePct,
          cheaper: lossy.cheaper,
          savingsPct: lossy.savingsPct,
        }
      : null,
    allowancePerDay: f.allowancePerDay,
    host: new URL(site).host,
  }
}
