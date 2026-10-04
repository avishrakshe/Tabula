import { after } from 'next/server'
import { tick } from '@/server/demo-run'
import { gateway } from '@/server/gateway'
import { json } from '@/server/request'

// a tick works for ~15s, but a close it starts can wait on a few devnet confirmations
export const maxDuration = 120

/** Advances a live run by one bounded tick (any viewer may call it; a running tick holds a lease). */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { id?: unknown }
  const id = Number(body.id)
  if (!Number.isSafeInteger(id) || id <= 0)
    return json({ error: 'bad_request', message: 'id is required' }, 400)
  const { gw } = await gateway()
  const run = await tick(gw, id)
  after(() => gw.sessions.drain()) // a voucher that tripped a kill keeps closing the channel
  return run ? json({ run }) : json({ error: 'not_found' }, 404)
}
