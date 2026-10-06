/**
 * Early-access sign-ups from the landing page. Deployed, they go to the Supabase ledger (the `waitlist`
 * table, RLS on); in a local rehearsal, to the gateway's PGlite ledger.
 */
import { type LedgerDb, openLedger } from '@tabula/ledger'
import { FLEETS, INTERESTS } from '@/lib/waitlist'
import { gateway } from './gateway'

export class WaitlistUnavailable extends Error {}

let db: Promise<LedgerDb> | null = null

/**
 * Supabase gets its own small pool: DATABASE_URL, else POSTGRES_URL (the transaction pooler the Supabase
 * Marketplace integration sets on the Vercel project). PGlite holds its directory exclusively, so a local
 * rehearsal shares the gateway's.
 */
export function waitlistDb(): Promise<LedgerDb> {
  db ??= (async () => {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL
    if (url && /^postgres(ql)?:\/\//.test(url)) return (await openLedger(url, { max: 2 })).db
    if (process.env.TABULA_DB_PATH) return (await gateway()).gw.ledger.db
    throw new WaitlistUnavailable('no database configured for sign-ups')
  })().catch((err) => {
    db = null // let the next request try again
    throw err
  })
  return db
}

export interface SignUp {
  email: string
  company: string | null
  interest: string | null
  fleet: string | null
}

// deliberately loose: one @, a dot in the domain, no spaces. The inbox decides the rest.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

const optional = (v: unknown, max: number) => {
  if (typeof v !== 'string') return null
  const s = v.trim().replace(/\s+/g, ' ')
  return s ? s.slice(0, max) : null
}

const oneOf = (v: unknown, allowed: readonly { id: string }[]) =>
  typeof v === 'string' && allowed.some((a) => a.id === v) ? v : null

/**
 * The form's JSON body, checked. `bot` is true when the hidden field was filled in: the caller answers
 * as if it worked and stores nothing.
 */
export function parseSignUp(
  body: unknown,
): { ok: true; value: SignUp; bot: boolean } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Send the form as JSON.' }
  const b = body as Record<string, unknown>
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
  if (!email) return { ok: false, error: 'Enter your email address.' }
  if (email.length > 254 || !EMAIL.test(email))
    return { ok: false, error: 'That email address doesn’t look right.' }
  return {
    ok: true,
    bot: typeof b.website === 'string' && b.website.trim() !== '',
    value: {
      email,
      company: optional(b.company, 120),
      interest: oneOf(b.interest, INTERESTS),
      fleet: oneOf(b.fleet, FLEETS),
    },
  }
}
