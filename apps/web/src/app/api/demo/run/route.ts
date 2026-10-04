import { after } from 'next/server'
import { DemoUnavailable, startRun, tick } from '@/server/demo-run'
import { gateway } from '@/server/gateway'
import { json, requesterHash, vendorBase } from '@/server/request'

export const maxDuration = 120

/** Starts a live run (or joins the one running) and takes its first tick. */
export async function POST(req: Request) {
  try {
    const { gw } = await gateway()
    const { run, joined } = await startRun(gw, { requester: requesterHash(req), vendorBase: vendorBase(req) })
    const first = joined ? run : ((await tick(gw, run.id)) ?? run)
    after(() => gw.sessions.drain())
    return json({ run: first, joined })
  } catch (err) {
    if (err instanceof DemoUnavailable) return json({ error: err.reason, message: err.message }, 503)
    return json({ error: 'unavailable', message: (err as Error).message }, 503)
  }
}
