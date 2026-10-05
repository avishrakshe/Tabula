import { schema } from '@tabula/ledger'
import { allow } from '@/server/rate-limit'
import { json, requesterHash } from '@/server/request'
import { parseSignUp, WaitlistUnavailable, waitlistDb } from '@/server/waitlist'

/**
 * Joins the waitlist. The answer is the same whether the email was new or already on the list, so the
 * form can't be used to find out who signed up.
 */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad_request', message: 'Send the form as JSON.' }, 400)
  }
  const parsed = parseSignUp(body)
  if (!parsed.ok) return json({ error: 'invalid', message: parsed.error }, 400)
  if (parsed.bot) return json({ ok: true })

  try {
    const db = await waitlistDb()
    const requester = requesterHash(req)
    if (!(await allow(db, `waitlist:ip:${requester}`, 10, 3_600_000)))
      return json(
        { error: 'rate_limited', message: 'Too many sign-ups from this network. Try again in an hour.' },
        429,
      )
    await db
      .insert(schema.waitlist)
      .values({ ...parsed.value, requester, createdAt: Date.now() })
      .onConflictDoNothing({ target: schema.waitlist.email })
    return json({ ok: true })
  } catch (err) {
    if (!(err instanceof WaitlistUnavailable)) console.error('[waitlist]', err)
    return json(
      {
        error: 'unavailable',
        message:
          err instanceof WaitlistUnavailable
            ? 'Sign-ups aren’t open on this deployment yet.'
            : 'Sign-ups are down for a moment. Please try again shortly.',
      },
      503,
    )
  }
}
