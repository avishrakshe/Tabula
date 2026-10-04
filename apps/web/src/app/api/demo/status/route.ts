import { activeRun, fundsProblem, latestRun } from '@/server/demo-run'
import { gateway } from '@/server/gateway'
import { json } from '@/server/request'

/** Whether a live run can start now, and the run in progress (if any). */
export async function GET() {
  try {
    const { gw } = await gateway()
    const [active, latest, problem] = await Promise.all([
      activeRun(gw.ledger.db),
      latestRun(gw.ledger.db),
      fundsProblem(gw).catch((err: Error) => `devnet unavailable (${err.message})`),
    ])
    return json({
      live: true,
      available: !problem,
      reason: problem,
      cluster: gw.config.cluster.name,
      activeId: active?.id ?? null,
      latest,
    })
  } catch (err) {
    // no database, no devnet: the dashboard stays on the recorded run
    return json({ live: false, available: false, reason: (err as Error).message, latest: null }, 200)
  }
}
