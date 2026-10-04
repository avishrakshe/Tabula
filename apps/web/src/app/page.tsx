import Link from 'next/link'

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-night px-6 text-center text-paper">
      <h1 className="max-w-3xl text-[44px] leading-[1.1] font-medium tracking-tight md:text-h1">
        Every agent payment, accounted for.
      </h1>
      <p className="max-w-xl text-body-lg text-gray-1">
        Spend control and treasury for AI agents that pay through Solana payment channels.
      </p>
      <Link
        href="/app"
        className="rounded-full bg-wax px-6 py-3 font-medium text-ink hover:bg-wax-deep hover:text-paper"
      >
        Open the dashboard
      </Link>
    </main>
  )
}
