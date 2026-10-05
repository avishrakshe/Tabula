import { ArrowRight, Check, Play } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { FilmPlayer } from '@/components/film/FilmPlayer'
import { Faq } from '@/components/site/Faq'
import { Frame } from '@/components/site/Frame'
import { HeroStage } from '@/components/site/HeroStage'
import { Wordmark } from '@/components/site/Logo'
import { GITHUB_URL, REPLAY_URL } from '@/components/site/links'
import { Nav } from '@/components/site/Nav'
import { Reveal } from '@/components/site/Reveal'
import { WaitlistForm } from '@/components/site/Waitlist'
import { filmFacts } from '@/lib/film-facts'
import { shortAddr, usd } from '@/lib/format'
import { runFacts } from '@/lib/run-facts'
import feedShot from '../../public/shots/feed.jpg'
import killShot from '../../public/shots/kill.jpg'
import payeeShot from '../../public/shots/payee.jpg'
import velocityShot from '../../public/shots/velocity.jpg'
import verifyShot from '../../public/shots/verify.jpg'

const BUILT_ON = [
  'Solana',
  'Payment channels program',
  'MPP sessions · @solana/mpp',
  'Squads v4',
  'Subscriptions & Allowances',
  'Memo program',
  'Solana devnet',
  'Solana Payment Sandbox',
]

function Container({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto max-w-[1200px] px-4 md:px-6 ${className}`}>{children}</div>
}

function SectionIntro({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <Reveal className="mx-auto max-w-[760px] text-center">
      <h2 className="text-[34px] leading-[1.15] font-medium tracking-[-0.02em] text-paper md:text-h2">
        {title}
      </h2>
      {children ? <p className="mx-auto mt-5 max-w-[60ch] text-body-lg text-gray-1">{children}</p> : null}
    </Reveal>
  )
}

function PillLink({
  href,
  children,
  variant = 'primary',
}: {
  href: string
  children: ReactNode
  variant?: 'primary' | 'ghost'
}) {
  const cls =
    variant === 'primary'
      ? 'bg-wax text-ink hover:bg-paper'
      : 'border border-white/20 text-paper hover:border-white/50 hover:bg-white/5'
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-2 rounded-full px-6 py-3 text-[15px] font-medium transition-colors ${cls}`}
    >
      {children}
    </Link>
  )
}

function FeatureRow({
  title,
  children,
  facts,
  shot,
  flip = false,
}: {
  title: string
  children: ReactNode
  facts: string[]
  shot: ReactNode
  flip?: boolean
}) {
  return (
    <div
      className={`grid items-center gap-10 md:gap-16 ${flip ? 'md:grid-cols-[1.15fr_0.85fr]' : 'md:grid-cols-[0.85fr_1.15fr]'}`}
    >
      <Reveal className={flip ? 'md:order-2' : ''}>
        <h3 className="text-h3 font-medium tracking-[-0.02em] text-paper">{title}</h3>
        <div className="mt-5 max-w-[56ch] space-y-4 text-body-lg text-gray-1">{children}</div>
        <ul className="mt-6 space-y-2.5">
          {facts.map((f) => (
            <li key={f} className="flex gap-2.5 text-[15px] text-paper">
              <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-wax" />
              <span className="num">{f}</span>
            </li>
          ))}
        </ul>
      </Reveal>
      <Reveal delay={0.1} className={flip ? 'md:order-1' : ''}>
        {shot}
      </Reveal>
    </div>
  )
}

export default function Home() {
  const f = runFacts()
  const lossy = f.scores.find((s) => s.cheaper) ?? null
  const where =
    f.cluster === 'devnet'
      ? 'Solana devnet (test USDC, no real funds)'
      : 'the Solana Payment Sandbox (a mainnet clone with test balances)'
  const runNote = `From a recorded run on ${where}, ${new Date(f.recordedAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })}.`

  return (
    <div className="min-h-screen bg-ink text-paper">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-wax focus:px-4 focus:py-2 focus:text-ink"
      >
        Skip to content
      </a>
      <Nav />
      <main id="main">
        {/* ---- hero ---------------------------------------------------------------------- */}
        <section className="relative overflow-hidden bg-night pt-36 md:pt-44">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-40 left-1/2 h-[640px] w-[1100px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(255,137,117,0.28),rgba(255,137,117,0.06)_55%,transparent)]"
          />
          <Container className="relative text-center">
            <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/5 px-4 py-1.5 text-sm text-gray-1">
              <span className="size-1.5 rounded-full bg-wax" aria-hidden />
              Spend control for agents that pay through Solana payment channels
            </p>
            <h1 className="mx-auto mt-7 max-w-[900px] text-[44px] leading-[1.1] font-medium tracking-[-0.02em] md:text-h1">
              Every agent payment, accounted for.
            </h1>
            <p className="mx-auto mt-6 max-w-[58ch] text-body-lg text-gray-1">
              Tabula holds your agents' keys, checks every voucher against your rules before it is signed,
              stops a runaway agent mid-stream, and anchors a receipt for every dollar onchain.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <PillLink href="#demo" variant="ghost">
                <Play aria-hidden className="size-3.5" fill="currentColor" /> Watch the film
              </PillLink>
              <PillLink href="/app">
                Open the dashboard <ArrowRight aria-hidden className="size-4" />
              </PillLink>
            </div>
          </Container>
          <HeroStage caption={runNote} />
        </section>

        {/* ---- built on ------------------------------------------------------------------ */}
        <section aria-label="Built on" className="border-y border-white/8 bg-ink py-8">
          <p className="mb-5 text-center text-xs tracking-[0.14em] text-gray-1 uppercase">Built on</p>
          <div className="marquee relative overflow-hidden">
            <ul className="marquee-track flex w-max gap-14 pr-14">
              {(['a', 'b'] as const).flatMap((copy) =>
                BUILT_ON.map((name) => (
                  <li
                    key={`${copy}-${name}`}
                    aria-hidden={copy === 'b'}
                    className="text-xl font-medium whitespace-nowrap text-gray-1"
                  >
                    {name}
                  </li>
                )),
              )}
            </ul>
          </div>
        </section>

        {/* ---- intro statement ----------------------------------------------------------- */}
        <section className="py-24 md:py-32">
          <Container>
            <SectionIntro title="Your books see two transactions. Your agent made five thousand payments.">
              A payment channel touches the chain when it opens and when it closes. Every payment in between
              is a voucher signed off-chain. Tabula is the ledger for that part.
            </SectionIntro>
            <Reveal className="mt-16">
              <Frame
                src={feedShot}
                alt="The live voucher feed and onchain activity timeline in the Tabula dashboard"
                caption={runNote}
                fade
              />
            </Reveal>
          </Container>
        </section>

        {/* ---- features ------------------------------------------------------------------ */}
        <section id="product" className="scroll-mt-20 pb-24 md:pb-32">
          <Container className="space-y-28 md:space-y-36">
            <FeatureRow
              title="Gate every voucher."
              facts={[
                'Per-task and daily budgets, unit-price caps, vendor allowlists',
                'Velocity windows and spend-anomaly detection',
                'Agents hold an API key, never a signing key',
              ]}
              shot={
                <Frame
                  src={velocityShot}
                  alt={`${f.kill.agentId}'s trailing 60-second spend climbing to its velocity limit`}
                  caption="Trailing spend against the velocity limit: exactly what the rule measures."
                  sizes="(min-width: 768px) 640px, 100vw"
                />
              }
            >
              <p>
                Every voucher is checked against your policy before it is signed. Tabula holds each agent's
                wallet and voucher key, and its signer refuses anything the policy did not approve, anything
                after a kill and anything above the channel's deposit.
              </p>
            </FeatureRow>

            <FeatureRow
              flip
              title="Stop a runaway agent mid-stream."
              facts={[
                `Voucher #${f.kill.voucherNumber} refused unsigned, ${f.kill.afterInjectionSec}s after the injected ticket`,
                `Channel closed at the last signed voucher: ${usd(f.kill.settled)} settled`,
                `${usd(f.kill.refunded)} swept back to the treasury vault`,
              ]}
              shot={
                <Frame
                  src={killShot}
                  alt={`The blocked voucher and the kill timeline for ${f.kill.agentId}, with explorer links`}
                  caption="Every step of the kill path, each with an explorer link."
                  sizes="(min-width: 768px) 640px, 100vw"
                  fade
                />
              }
            >
              <p>
                In the recorded run, {f.kill.agentId} reads a prompt-injected support ticket and starts
                calling as fast as it can. The velocity rule catches the one voucher that would cross the
                line, and Tabula stops the agent, closes its channel and returns the unspent escrow, while the
                other agents keep working.
              </p>
            </FeatureRow>

            <FeatureRow
              title="Block swapped payees."
              facts={[
                'Payee, mint, program, price and splits checked against your registry',
                'The open transaction is simulated: only the deposit may leave',
                `${f.payee.agentId}'s "faster mirror" offered ${shortAddr(f.payee.offered)}, not ${shortAddr(f.payee.expected)}`,
              ]}
              shot={
                <Frame
                  src={payeeShot}
                  alt="A blocked payment request: PAYEE_MISMATCH, with the offered and registered payees"
                  caption="Refused before anything was signed."
                  sizes="(min-width: 768px) 640px, 100vw"
                />
              }
            >
              <p>
                Before a channel opens, Tabula checks the vendor's 402 payment request against your registry
                and simulates the transaction. When {f.payee.agentId} followed a poisoned link to a mirror of{' '}
                {f.payee.vendorId}, the request named a different payee, and the agent fell back to the real
                vendor.
              </p>
            </FeatureRow>

            <FeatureRow
              flip
              title="Prove every dollar."
              facts={[
                `${f.batches.matched} of ${f.batches.total} ledger batches verified against their onchain memos`,
                `${f.channels.matched} of ${f.channels.total} channels MATCHED against onchain settlement`,
                `Vault down ${usd(f.vault.start - f.vault.end)}: exactly what vendors settled`,
              ]}
              shot={
                <Frame
                  src={verifyShot}
                  alt="A ledger batch verified in the browser: the recomputed Merkle root matches the onchain memo"
                  caption="Verify recomputes the Merkle root in your browser and compares it with the chain."
                  sizes="(min-width: 768px) 640px, 100vw"
                  fade
                />
              }
            >
              <p>
                Tabula anchors a Merkle root of the ledger onchain every 40 vouchers with the Memo program,
                and reconciles each channel against what actually settled when it closes. Export every voucher
                to CSV, each with its receipt transaction.
              </p>
            </FeatureRow>
          </Container>
        </section>

        {/* ---- statement band ------------------------------------------------------------ */}
        <section className="px-4 md:px-6">
          <Reveal className="relative mx-auto max-w-[1200px] overflow-hidden rounded-[28px] border border-white/10 bg-night px-6 py-20 text-center md:px-16 md:py-28">
            <div
              aria-hidden
              className="pointer-events-none absolute -bottom-48 left-1/2 h-[480px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(255,137,117,0.22),transparent)]"
            />
            <div className="relative">
              <h2 className="mx-auto max-w-[820px] text-[34px] leading-[1.15] font-medium tracking-[-0.02em] md:text-h2">
                Agents can pay per call now. Someone has to watch the meter.
              </h2>
              <p className="mx-auto mt-6 max-w-[62ch] text-body-lg text-gray-1">
                Payment channels are live on Solana mainnet. An agent escrows a deposit once, then streams
                signed vouchers to a vendor, thousands per session and none of them onchain. That is what
                makes per-call pricing work, and it is also how a prompt-injected agent empties its escrow
                before anyone looks.
              </p>
              <div className="mt-9 flex justify-center">
                <PillLink href={REPLAY_URL}>
                  Watch the recorded run <ArrowRight aria-hidden className="size-4" />
                </PillLink>
              </div>
            </div>
          </Reveal>
        </section>

        {/* ---- three cards --------------------------------------------------------------- */}
        <section className="py-24 md:py-32">
          <Container>
            <SectionIntro title="Treasury, not just guardrails.">
              Escrow sitting in a channel is money out of your treasury. Tabula sizes it, sweeps it and keeps
              the hard limit onchain.
            </SectionIntro>
            <div className="mt-16 grid gap-5 md:grid-cols-3">
              {[
                {
                  title: 'Sweep idle escrow.',
                  body: 'The float manager closes channels nobody is paying through and returns the float to the vault.',
                  stat: usd(f.idleSweep.refunded),
                  note: `reclaimed from ${f.idleSweep.agentId}'s abandoned channel with ${f.idleSweep.vendorId}`,
                },
                {
                  title: 'Vendor scorecards.',
                  body: 'Waste and cost per completed task, computed from your own paid calls, with a cheaper option when there is one.',
                  stat: lossy ? `${lossy.wastePct}%` : '—',
                  note: lossy
                    ? `of ${lossy.vendorId}'s paid calls wasted; ${lossy.cheaper} does the same task ${lossy.savingsPct}% cheaper`
                    : 'no waste in this run',
                },
                {
                  title: 'Onchain ceilings.',
                  body: 'Agent wallets are funded just in time from a Squads vault through onchain allowances. If every off-chain check failed, the allowance still holds.',
                  stat: `${usd(f.allowancePerDay)}/day`,
                  note: 'allowance per agent in the demo, enforced by the Subscriptions program',
                },
              ].map((c, i) => (
                <Reveal key={c.title} delay={i * 0.08}>
                  <article className="flex h-full flex-col rounded-[22px] border border-white/10 bg-linear-to-b from-night-2 to-night p-7">
                    <h3 className="text-h4 font-medium tracking-[-0.01em]">{c.title}</h3>
                    <p className="mt-3 text-[15px] leading-[1.5] text-gray-1">{c.body}</p>
                    <div className="mt-auto pt-10">
                      <p className="num text-h2 font-medium tracking-[-0.02em] text-wax">{c.stat}</p>
                      <p className="mt-1 text-sm text-gray-1">{c.note}</p>
                    </div>
                  </article>
                </Reveal>
              ))}
            </div>
          </Container>
        </section>

        {/* ---- how it works -------------------------------------------------------------- */}
        <section className="border-t border-white/8 py-24 md:py-32">
          <Container>
            <SectionIntro title="How it works" />
            <ol className="mt-16 grid gap-5 md:grid-cols-5">
              {[
                [
                  'Fund',
                  'A Squads vault grants each agent an onchain daily allowance. Deposits are pulled just in time.',
                ],
                [
                  'Verify',
                  "Each vendor's 402 payment request is checked against your registry and simulated before a channel opens.",
                ],
                ['Gate', 'Every voucher passes your policy before the guarded signer will sign it.'],
                [
                  'Stop',
                  'A tripped rule or one click stops the agent, closes its channels and sweeps the refund home.',
                ],
                ['Prove', 'Merkle roots anchored onchain, channels reconciled, every voucher exportable.'],
              ].map(([step, body], i) => (
                <li key={step}>
                  <Reveal
                    delay={i * 0.06}
                    className="h-full rounded-[22px] border border-white/10 bg-night p-6"
                  >
                    <span className="num text-sm text-wax">0{i + 1}</span>
                    <h3 className="mt-3 text-h5 font-medium">{step}</h3>
                    <p className="mt-2 text-[15px] leading-[1.5] text-gray-1">{body}</p>
                  </Reveal>
                </li>
              ))}
            </ol>
          </Container>
        </section>

        {/* ---- pricing ------------------------------------------------------------------- */}
        <section id="pricing" className="scroll-mt-20 border-t border-white/8 py-24 md:py-32">
          <Container>
            <SectionIntro title="Pricing">
              Start free with a small team of agents. Scale pricing follows what you run through Tabula.
            </SectionIntro>
            <div className="mx-auto mt-16 grid max-w-[960px] gap-5 md:grid-cols-2">
              <Reveal>
                <article className="flex h-full flex-col rounded-[24px] border border-white/10 bg-night p-8">
                  <h3 className="text-h3 font-medium">Team</h3>
                  <p className="mt-2 text-gray-1">For your first agents.</p>
                  <p className="mt-8 text-h2 font-medium tracking-[-0.02em]">Free</p>
                  <p className="text-sm text-gray-1">up to 3 agents</p>
                  <ul className="mt-8 space-y-3 border-t border-white/10 pt-8 text-[15px]">
                    {[
                      'Policy-gated vouchers and the guarded signer',
                      'Kill switch, refunds and idle sweeps',
                      'Onchain receipts and reconciliation',
                      'Dashboard, audit log and CSV export',
                    ].map((x) => (
                      <li key={x} className="flex gap-2.5">
                        <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-wax" />
                        {x}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-auto pt-10">
                    <PillLink href="/app" variant="ghost">
                      Open the dashboard
                    </PillLink>
                  </div>
                </article>
              </Reveal>
              <Reveal delay={0.08}>
                <article className="relative flex h-full flex-col overflow-hidden rounded-[24px] border border-wax/30 bg-linear-to-b from-[#3a1d18] via-night to-night p-8">
                  <div
                    aria-hidden
                    className="pointer-events-none absolute -top-32 -right-24 h-80 w-80 rounded-full bg-[radial-gradient(closest-side,rgba(255,137,117,0.35),transparent)]"
                  />
                  <h3 className="relative text-h3 font-medium">Scale</h3>
                  <p className="relative mt-2 text-gray-1">For fleets of agents and real spend.</p>
                  <p className="relative mt-8 text-h4 leading-[1.3] font-medium">
                    Per agent per month, plus basis points on managed spend
                  </p>
                  <p className="relative text-sm text-gray-1">pricing on request</p>
                  <ul className="relative mt-8 space-y-3 border-t border-white/10 pt-8 text-[15px]">
                    {[
                      'Everything in Team, for any number of agents',
                      'Vendor scorecards and float management',
                      'Squads vault and onchain allowances per agent',
                      'Treasury yield on idle float, shared instead of a higher fee (planned)',
                    ].map((x) => (
                      <li key={x} className="flex gap-2.5">
                        <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-wax" />
                        {x}
                      </li>
                    ))}
                  </ul>
                  <div className="relative mt-auto pt-10">
                    <PillLink href="#waitlist">
                      Join the waitlist <ArrowRight aria-hidden className="size-4" />
                    </PillLink>
                  </div>
                </article>
              </Reveal>
            </div>
          </Container>
        </section>

        {/* ---- FAQ ----------------------------------------------------------------------- */}
        <section className="border-t border-white/8 py-24 md:py-32">
          <Container className="grid gap-12 md:grid-cols-[0.8fr_1.2fr] md:gap-20">
            <Reveal>
              <h2 className="text-[34px] leading-[1.15] font-medium tracking-[-0.02em] md:text-h2">
                Questions, answered plainly.
              </h2>
              <p className="mt-5 max-w-[40ch] text-body-lg text-gray-1">
                Tabula is open source. Read the code, or watch the recorded run and check every receipt.
              </p>
            </Reveal>
            <Faq
              items={[
                {
                  q: 'Do agents ever hold keys?',
                  a: 'No. An agent gets an API key for the Tabula gateway and nothing else. Tabula holds each agent’s payer wallet and a separate voucher key, and the signer refuses anything policy did not approve, anything after a kill and anything above the channel’s deposit.',
                },
                {
                  q: 'What if Tabula goes down?',
                  a: 'Then nothing gets signed, so nothing new is spent. Agent wallets are funded from your Squads vault through onchain allowances, so the most an agent can draw in a day is capped onchain regardless. An open channel can be closed onchain after the program’s grace period, and the unspent escrow returns to the agent wallet.',
                },
                {
                  q: 'Is this custodial?',
                  a: 'Tabula holds the agents’ operating keys and their small working float, not your treasury. The treasury stays in your Squads vault, Tabula can only draw what each onchain allowance permits, and idle float is swept back. The code is MIT-licensed, so you can run the gateway yourself.',
                },
                {
                  q: 'Which payment protocols work?',
                  a: 'Today, MPP payment sessions on the Solana payment-channels program, paid in USDC. Vendors run an unmodified @solana/mpp session server; Tabula is the client side for your agents.',
                },
                {
                  q: 'Is the yield risky?',
                  a: 'There is no yield in this build. If we add treasury yield on idle float, it will be off by default, opt-in per treasury, and its risks will be stated next to the switch.',
                },
              ]}
            />
          </Container>
        </section>

        {/* ---- the film ------------------------------------------------------------------ */}
        <section id="demo" className="scroll-mt-20 border-t border-white/8 py-24 md:py-32">
          <Container>
            <SectionIntro title="Tabula in 81 seconds.">
              A motion-graphic tour of what Tabula does, from the first voucher to the last receipt. The
              blocked voucher, the refund, the receipts and the scorecards are the real figures from the
              recorded run on Solana {f.cluster}.
            </SectionIntro>
            <Reveal className="mt-14">
              <FilmPlayer facts={filmFacts()} />
            </Reveal>
            <p className="mt-8 text-center text-[15px] text-gray-1">
              Prefer the real thing? The whole run, {Math.floor(f.durationSec / 60)} min {f.durationSec % 60}{' '}
              s, {f.signed} vouchers signed and {f.blocked} blocked, replays in the dashboard.{' '}
              <Link
                href={REPLAY_URL}
                className="whitespace-nowrap text-paper underline decoration-wax underline-offset-4"
              >
                Watch the recorded run
              </Link>
            </p>
          </Container>
        </section>

        {/* ---- waitlist ------------------------------------------------------------------ */}
        <section id="waitlist" className="scroll-mt-20 px-4 pb-24 md:px-6 md:pb-32">
          <div className="relative mx-auto max-w-[1200px] overflow-hidden rounded-[28px] border border-white/10 bg-night px-5 py-14 md:px-14 md:py-20">
            <div
              aria-hidden
              className="pointer-events-none absolute -top-56 -left-40 h-[560px] w-[760px] rounded-full bg-[radial-gradient(closest-side,rgba(255,137,117,0.22),transparent)]"
            />
            <div className="relative grid items-center gap-12 md:grid-cols-[0.85fr_1.15fr] md:gap-14">
              <Reveal>
                <p className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/5 px-4 py-1.5 text-sm text-gray-1">
                  <span className="size-1.5 rounded-full bg-wax" aria-hidden />
                  Private beta · live on Solana {f.cluster}
                </p>
                <h2 className="mt-6 text-[38px] leading-[1.1] font-medium tracking-[-0.02em] md:text-h2">
                  Get early access.
                </h2>
                <p className="mt-5 max-w-[46ch] text-body-lg text-gray-1">
                  We’re bringing on a small group of teams whose agents pay per call. Leave your email and
                  we’ll reach out when there’s a spot.
                </p>
                <ul className="mt-8 space-y-3 text-[15px]">
                  {[
                    'Free for up to 3 agents',
                    'Early teams shape what we build next',
                    'Design partners move to mainnet first',
                  ].map((x) => (
                    <li key={x} className="flex gap-2.5">
                      <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-wax" />
                      {x}
                    </li>
                  ))}
                </ul>
              </Reveal>
              <Reveal delay={0.08}>
                <WaitlistForm />
              </Reveal>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/8">
        <Container className="flex flex-col gap-8 py-12 md:flex-row md:items-end md:justify-between">
          <div>
            <Link href="/" className="text-h3" aria-label="Tabula home">
              <Wordmark markClassName="h-8 w-auto" />
            </Link>
            <p className="mt-3 text-sm text-gray-1">Every agent payment, accounted for. MIT licensed.</p>
          </div>
          <ul className="flex flex-wrap gap-x-8 gap-y-3 text-[15px] text-gray-1">
            <li>
              <Link href="/film" className="hover:text-paper">
                Film
              </Link>
            </li>
            <li>
              <a href="#waitlist" className="hover:text-paper">
                Waitlist
              </a>
            </li>
            <li>
              <Link href={REPLAY_URL} className="hover:text-paper">
                Recorded run
              </Link>
            </li>
            <li>
              <Link href="/app" className="hover:text-paper">
                Dashboard
              </Link>
            </li>
            <li>
              <a href={`${GITHUB_URL}#readme`} className="hover:text-paper">
                Docs
              </a>
            </li>
            <li>
              <a href={GITHUB_URL} className="hover:text-paper">
                GitHub
              </a>
            </li>
          </ul>
        </Container>
      </footer>
    </div>
  )
}
