import { latestRun } from '@/server/demo-run'
import { gateway } from '@/server/gateway'
import { json } from '@/server/request'

export const maxDuration = 60

/** Ledger views that move with every paid call (database reads, plus the vault's balance). */
const FAST = {
  overview: '/v1/overview',
  agents: '/v1/agents?onchain=0', // statuses (a kill shows at once); allowances come with the slow views
  channels: '/v1/channels',
  float: '/v1/float',
  scores: '/v1/scores',
  challenges: '/v1/challenges',
  batches: '/v1/batches',
}

/** Views that read the chain once per agent or channel: refreshed every few polls, not every one. */
const SLOW = {
  agents: '/v1/agents',
  vendors: '/v1/vendors',
  policies: '/v1/policies',
  reconcile: '/v1/reconcile?limit=30',
}

const cursor = (q: URLSearchParams, key: string) => {
  const n = Number(q.get(key))
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * Everything the hosted dashboard shows, in one call: a serverless function can't hold the gateway's event
 * stream open, so the dashboard polls this instead. `v` and `e` are the newest voucher and event ids the
 * viewer already has; only newer rows come back. `full=1` adds the slow views and the whole recent voucher
 * list (anchoring stamps a batch onto rows the viewer already has).
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams
  const full = q.get('full') === '1'
  const v = cursor(q, 'v')
  const e = cursor(q, 'e')
  const { gw, app } = await gateway()
  const paths: Record<string, string> = {
    ...FAST,
    ...(full ? SLOW : {}),
    vouchers: full || v === null ? '/v1/vouchers?limit=2000' : `/v1/vouchers?after=${v}&limit=2000`,
    events: e === null ? '/v1/events?limit=500' : `/v1/events?after=${e}&limit=500`,
  }
  const headers = { authorization: `Bearer ${gw.config.adminToken}` }
  const parts = await Promise.all(
    Object.entries(paths).map(async ([key, url]) => {
      const res = await app.inject({ method: 'GET', url, headers })
      // one view failing (an RPC hiccup) leaves the viewer's copy of it as it was
      return res.statusCode === 200 ? ([key, res.json()] as const) : null
    }),
  )
  return json({
    ...Object.fromEntries(parts.filter((p) => p !== null)),
    run: await latestRun(gw.ledger.db),
    full,
  })
}
