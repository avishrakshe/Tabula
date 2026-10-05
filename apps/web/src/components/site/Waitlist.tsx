'use client'

import { ArrowRight, Check, LoaderCircle } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { FLEETS, INTERESTS } from '@/lib/waitlist'
import { LogoMark } from './Logo'
import { GITHUB_URL } from './links'

type State =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; email: string }
  | { kind: 'error'; message: string; closed?: boolean }

const chip =
  'cursor-pointer rounded-full border border-white/12 px-3.5 py-2 text-sm text-gray-1 transition-colors select-none hover:border-white/30 hover:text-paper peer-checked:border-wax peer-checked:bg-wax/12 peer-checked:text-paper peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-wax'

/** The early-access form, styled as the thing Tabula signs: a voucher. */
export function WaitlistForm() {
  const id = useId()
  const [state, setState] = useState<State>({ kind: 'idle' })

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const body = Object.fromEntries(form.entries())
    setState({ kind: 'sending' })
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string }
      if (res.ok && out.ok) setState({ kind: 'done', email: String(body.email ?? '').trim() })
      else
        setState({
          kind: 'error',
          message: out.message ?? 'Something went wrong. Please try again.',
          closed: res.status === 404 || out.error === 'unavailable',
        })
    } catch {
      setState({ kind: 'error', message: 'Couldn’t reach the server. Check your connection and try again.' })
    }
  }

  return (
    <div className="relative rounded-[24px] border border-white/12 bg-linear-to-b from-night-2 to-night shadow-[0_40px_120px_-48px_rgba(255,137,117,0.45)]">
      {/* voucher header */}
      <div className="flex items-center justify-between px-6 pt-6 md:px-8 md:pt-7">
        <span className="inline-flex items-center gap-2.5 text-xs tracking-[0.16em] text-gray-1 uppercase">
          <LogoMark className="h-4 w-auto text-paper" />
          Early access voucher
        </span>
        <span className="hidden font-mono text-xs text-gray-3 sm:inline">tabula:v1 · beta</span>
      </div>
      {/* the perforation, with notches cut into both edges */}
      <div aria-hidden className="relative my-6 h-px">
        <div className="absolute inset-x-6 top-0 border-t border-dashed border-white/15 md:inset-x-8" />
        <div className="absolute top-1/2 -left-3 size-6 -translate-y-1/2 rounded-full border border-white/12 bg-night [clip-path:inset(0_0_0_50%)]" />
        <div className="absolute top-1/2 -right-3 size-6 -translate-y-1/2 rounded-full border border-white/12 bg-night [clip-path:inset(0_50%_0_0)]" />
      </div>

      {state.kind === 'done' ? (
        <div className="relative px-6 pb-8 md:px-8 md:pb-10" aria-live="polite">
          <div className="pointer-events-none absolute top-0 right-6 rotate-[-8deg] rounded-lg border-2 border-wax px-3 py-1 font-mono text-sm font-semibold tracking-[0.2em] text-wax md:right-8">
            SIGNED
          </div>
          <span className="flex size-11 items-center justify-center rounded-full bg-wax text-ink">
            <Check aria-hidden className="size-5" strokeWidth={2.5} />
          </span>
          <h3 className="mt-5 text-h3 font-medium tracking-[-0.02em]">You’re on the list.</h3>
          <p className="mt-3 max-w-[44ch] text-body-lg text-gray-1">
            We’ll write to <span className="break-all text-paper">{state.email}</span> when there’s a spot.
            Until then, the film above shows what’s coming, and the dashboard runs the real thing on devnet.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a
              href="/app"
              className="inline-flex items-center gap-2 rounded-full bg-wax px-5 py-2.5 text-[15px] font-medium text-ink transition-colors hover:bg-paper"
            >
              Open the dashboard <ArrowRight aria-hidden className="size-4" />
            </a>
            <a
              href={GITHUB_URL}
              className="inline-flex items-center rounded-full border border-white/20 px-5 py-2.5 text-[15px] font-medium text-paper transition-colors hover:border-white/50"
            >
              Star the repo
            </a>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="px-6 pb-7 md:px-8 md:pb-8" noValidate>
          <label htmlFor={`${id}-email`} className="text-sm text-gray-1">
            Work email
          </label>
          <div className="mt-2 flex flex-col gap-2.5 sm:flex-row">
            <input
              id={`${id}-email`}
              name="email"
              type="email"
              required
              autoComplete="email"
              inputMode="email"
              placeholder="you@company.com"
              aria-invalid={state.kind === 'error' && !state.closed ? true : undefined}
              aria-describedby={`${id}-status`}
              className="min-w-0 flex-1 rounded-full border border-white/15 bg-ink px-5 py-3 text-[15px] text-paper placeholder:text-gray-3 focus:border-wax focus:outline-none"
            />
            <button
              type="submit"
              disabled={state.kind === 'sending'}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-wax px-6 py-3 text-[15px] font-medium whitespace-nowrap text-ink transition-colors hover:bg-paper disabled:opacity-70"
            >
              {state.kind === 'sending' ? (
                <>
                  <LoaderCircle aria-hidden className="size-4 animate-spin" /> Signing…
                </>
              ) : (
                <>
                  Join the waitlist <ArrowRight aria-hidden className="size-4" />
                </>
              )}
            </button>
          </div>

          <fieldset className="mt-6">
            <legend className="text-sm text-gray-1">What brings you here?</legend>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {INTERESTS.map((o) => (
                <label key={o.id} className="relative">
                  <input type="radio" name="interest" value={o.id} className="peer sr-only" />
                  <span className={chip}>{o.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-6 grid gap-6 sm:grid-cols-[1fr_1fr]">
            <fieldset>
              <legend className="text-sm text-gray-1">Agents you run</legend>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {FLEETS.map((o) => (
                  <label key={o.id} className="relative">
                    <input type="radio" name="fleet" value={o.id} className="peer sr-only" />
                    <span className={chip}>{o.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <label htmlFor={`${id}-company`} className="text-sm text-gray-1">
                Company <span className="text-gray-3">(optional)</span>
              </label>
              <input
                id={`${id}-company`}
                name="company"
                type="text"
                autoComplete="organization"
                maxLength={120}
                className="mt-2.5 w-full rounded-full border border-white/15 bg-ink px-5 py-2.5 text-[15px] text-paper focus:border-wax focus:outline-none"
              />
            </div>
          </div>

          {/* a field people never see; bots fill it in */}
          <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
            <label htmlFor={`${id}-website`}>Website</label>
            <input id={`${id}-website`} name="website" type="text" tabIndex={-1} autoComplete="off" />
          </div>

          <p id={`${id}-status`} aria-live="polite" className="mt-5 min-h-5 text-sm">
            {state.kind === 'error' ? (
              <span className="text-[#ff8b7d]">
                {state.message}
                {state.closed ? (
                  <>
                    {' '}
                    <a
                      href={`${GITHUB_URL}/issues`}
                      className="underline underline-offset-2 hover:text-paper"
                    >
                      Say hello on GitHub
                    </a>{' '}
                    instead.
                  </>
                ) : null}
              </span>
            ) : (
              <span className="text-gray-3">One email when your spot opens. No newsletter, no sharing.</span>
            )}
          </p>
        </form>
      )}
    </div>
  )
}
