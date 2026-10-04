import { timingSafeEqual } from 'node:crypto'
import { after } from 'next/server'
import { activeRun, tick } from '@/server/demo-run'
import { gateway } from '@/server/gateway'
import { json } from '@/server/request'

export const maxDuration = 120

/** Constant-time check of `Authorization: Bearer <CRON_SECRET>`. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const got = Buffer.from(req.headers.get('authorization') ?? '')
  const want = Buffer.from(`Bearer ${secret}`)
  return got.length === want.length && timingSafeEqual(got, want)
}

/**
 * Jobs Supabase pg_cron calls every minute (Vercel Hobby crons run at most daily):
 * - anchor: anchor every finalized ledger row onchain
 * - sweep: close idle channels, finish stalled or forced closes, settle vendor calls cut off mid-flight
 * - demo: advance a live run nobody is watching, so it still finishes
 */
export async function POST(req: Request, ctx: { params: Promise<{ job: string }> }) {
  if (!authorized(req)) return json({ error: 'unauthorized' }, 401)
  const { job } = await ctx.params
  const { gw } = await gateway()
  after(() => gw.sessions.drain())
  switch (job) {
    case 'anchor':
      return json({ batches: (await gw.anchorer.anchorAll()).map((b) => b.id) })
    case 'sweep': {
      const resumed = await gw.sessions.resumeStalledCloses()
      const dangling = await gw.store.finalizeDangling(2 * 60_000)
      const swept = await gw.sessions.sweepIdle()
      return json({ resumed: resumed.length, dangling, reclaimed: swept.reclaimed })
    }
    case 'demo': {
      const run = await activeRun(gw.ledger.db)
      return json({ run: run ? await tick(gw, run.id) : null })
    }
    default:
      return json({ error: 'unknown job' }, 404)
  }
}
