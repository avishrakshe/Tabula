'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { GITHUB_URL } from './links'

const LINKS = [
  { href: '#product', label: 'Product' },
  { href: '#pricing', label: 'Pricing' },
  { href: `${GITHUB_URL}#readme`, label: 'Docs' },
  { href: GITHUB_URL, label: 'GitHub' },
]

export function Nav() {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-colors duration-300 ${scrolled ? 'border-b border-white/8 bg-ink/80 backdrop-blur-md' : 'border-b border-transparent'}`}
    >
      <nav
        className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-6 px-4 md:px-6"
        aria-label="Main"
      >
        <Link href="/" className="text-h5 font-semibold tracking-tight text-paper">
          Tabula
        </Link>
        <ul className="hidden items-center gap-8 text-[15px] text-gray-1 md:flex">
          {LINKS.map((l) => (
            <li key={l.label}>
              <a href={l.href} className="transition-colors hover:text-paper">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <Link
          href="/app"
          className="rounded-full bg-wax px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper"
        >
          Open the dashboard
        </Link>
      </nav>
    </header>
  )
}
