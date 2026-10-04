import { activeRun, fundsProblem, latestRun } from '@/server/demo-run'
import { gateway } from '@/server/gateway'
import { json, scrub } from '@/server/request'

const FUNDS_WAIT_MS = 2_500

/** Whether a live run can start now, and the run in progress (if any). */
export async function GET() {
  try {
    const { gw } = await gateway()
    if (!(await gw.store.agent('research-01')))
      return json({ live: false, available: false, reason: 'the live demo is not set up', latest: null })
    const [active, latest, problem] = await Promise.all([
      activeRun(gw.ledger.db),
      latestRun(gw.ledger.db),
      // a cold check is a dozen RPC reads: past FUNDS_WAIT_MS, answer without it (it finishes in the
      // background for the next viewer, and starting a run checks again)
      Promise.race([
        fundsProblem(gw).catch((err: Error) => `devnet is not answering (${scrub(err.message)})`),
        new Promise<null>((r) => setTimeout(() => r(null), FUNDS_WAIT_MS)),
      ]),
    ])
    return json({
      live: true,
      available: !problem || !!active, // a run in progress can always be watched
      reason: problem,
      cluster: gw.config.cluster.name,
      activeId: active?.id ?? null,
      latest,
    })
  } catch (err) {
    // no database (or it is paused): the dashboard stays on the recorded run
    console.error('[demo/status]', err)
    return json({ live: false, available: false, reason: 'the live ledger is offline', latest: null })
  }
}
