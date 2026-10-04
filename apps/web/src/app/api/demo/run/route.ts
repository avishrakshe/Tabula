import { DemoUnavailable, startRun } from '@/server/demo-run'
import { gateway } from '@/server/gateway'
import { json, requesterHash, scrub, vendorBase } from '@/server/request'

export const maxDuration = 60

/**
 * Starts a live run (or joins the one running). The viewer's dashboard then drives it with
 * `/api/demo/tick`, and cron finishes it if they leave.
 */
export async function POST(req: Request) {
  try {
    const { gw } = await gateway()
    const { run, joined } = await startRun(gw, { requester: requesterHash(req), vendorBase: vendorBase(req) })
    return json({ run, joined })
  } catch (err) {
    if (err instanceof DemoUnavailable) return json({ error: err.reason, message: err.message }, 503)
    console.error('[demo/run]', err)
    return json(
      { error: 'unavailable', message: `The live demo could not start (${scrub((err as Error).message)})` },
      503,
    )
  }
}
