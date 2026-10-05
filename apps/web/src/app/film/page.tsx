import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FilmPlayer } from '@/components/film/FilmPlayer'
import { Wordmark } from '@/components/site/Logo'
import { filmFacts } from '@/lib/film-facts'

export const metadata: Metadata = {
  title: 'The Tabula film — Every agent payment, accounted for',
  description:
    'An 81-second motion graphic of what Tabula does: policy-gated vouchers, a runaway agent stopped mid-stream, a swapped payee blocked, and every dollar proven onchain.',
}

/** scripts/render-film.ts writes it; offered for download only when it ships */
const MP4_PATH = '/film/tabula-film.mp4'

export default function FilmPage() {
  const mp4 = existsSync(join(process.cwd(), 'public', MP4_PATH)) ? MP4_PATH : undefined
  return (
    <div className="min-h-screen bg-ink text-paper">
      <header className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-4 md:px-6">
        <Link href="/" className="text-h5" aria-label="Tabula home">
          <Wordmark />
        </Link>
        <Link href="/" className="inline-flex items-center gap-2 text-sm text-gray-1 hover:text-paper">
          <ArrowLeft aria-hidden className="size-4" /> Back to the site
        </Link>
      </header>
      <main className="mx-auto max-w-[1200px] px-4 pt-6 pb-24 md:px-6 md:pt-10">
        <h1 className="text-[34px] leading-[1.15] font-medium tracking-[-0.02em] md:text-h2">
          The Tabula film
        </h1>
        <p className="mt-3 max-w-[60ch] text-body-lg text-gray-1">
          What Tabula does, in 81 seconds. The blocked voucher, the refund, the receipts and the scorecards
          are the real figures from the recorded run on Solana devnet.
        </p>
        <div className="mt-10">
          <FilmPlayer facts={filmFacts()} waitlistHref="/#waitlist" mp4={mp4} />
        </div>
      </main>
    </div>
  )
}
