'use client'

import { Menu, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Wordmark } from './Logo'
import { GITHUB_URL } from './links'

const LINKS = [
  { href: '#product', label: 'Product' },
  { href: '#demo', label: 'Demo' },
  { href: '#pricing', label: 'Pricing' },
  { href: `${GITHUB_URL}#readme`, label: 'Docs' },
  { href: GITHUB_URL, label: 'GitHub' },
]

export function Nav() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  // the mobile menu closes on Escape and when the viewport grows past it
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    const wide = window.matchMedia('(min-width: 768px)')
    const resize = () => wide.matches && setOpen(false)
    window.addEventListener('keydown', key)
    wide.addEventListener('change', resize)
    return () => {
      window.removeEventListener('keydown', key)
      wide.removeEventListener('change', resize)
    }
  }, [open])

  const solid = scrolled || open
  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-colors duration-300 ${solid ? 'border-b border-white/8 bg-ink/85 backdrop-blur-md' : 'border-b border-transparent'}`}
    >
      <nav
        className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-6 px-4 md:px-6"
        aria-label="Main"
      >
        <Link href="/" className="text-h5 text-paper" aria-label="Tabula home">
          <Wordmark />
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
        <div className="flex items-center gap-2">
          <Link
            href="/app"
            className="hidden rounded-full px-4 py-2 text-sm font-medium text-paper transition-colors hover:bg-white/8 md:inline-flex"
          >
            Dashboard
          </Link>
          <a
            href="#waitlist"
            className="rounded-full bg-wax px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper"
          >
            Join the waitlist
          </a>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
            className="-mr-1 rounded-full p-2 text-paper hover:bg-white/8 md:hidden"
          >
            {open ? <X aria-hidden className="size-5" /> : <Menu aria-hidden className="size-5" />}
          </button>
        </div>
      </nav>
      {open ? (
        <div id="mobile-menu" className="border-t border-white/8 px-4 pt-2 pb-5 md:hidden">
          <ul className="flex flex-col text-body-lg">
            {[...LINKS, { href: '/app', label: 'Dashboard' }].map((l) => (
              <li key={l.label}>
                <a
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="block border-b border-white/8 py-3.5 text-paper"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </header>
  )
}
