'use client'

import { useReducedMotion } from 'motion/react'
import dynamic from 'next/dynamic'
import { useEffect, useRef, useState } from 'react'

const HeroScene = dynamic(() => import('./HeroScene'), { ssr: false, loading: () => <StillTablet /> })

type Quality = 'none' | 'low' | 'high'

/**
 * Picks a quality tier from detect-gpu (benchmarks served from /gpu), defaulting to low.
 * `?quality=high|low|none` overrides it (embeds, and checking the scene on any machine).
 */
function useQuality(): Quality | null {
  const [quality, setQuality] = useState<Quality | null>(null)
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get('quality')
    if (asked === 'high' || asked === 'low' || asked === 'none') {
      setQuality(asked)
      return
    }
    let cancelled = false
    const fallback = setTimeout(() => !cancelled && setQuality((q) => q ?? 'low'), 2500)
    import('detect-gpu')
      .then(({ getGPUTier }) => getGPUTier({ benchmarksURL: '/gpu' }))
      .then((r) => {
        if (cancelled) return
        setQuality(r.tier === 0 ? 'none' : r.tier === 1 ? 'low' : 'high')
      })
      .catch(() => !cancelled && setQuality('low'))
    return () => {
      cancelled = true
      clearTimeout(fallback)
    }
  }, [])
  return quality
}

/** The CSS stand-in: shown while the scene loads, and instead of it on devices without a usable GPU. */
export function StillTablet() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative aspect-[3/2] w-[min(56%,460px)] rounded-[14px] border border-white/10 bg-linear-to-b from-[#1d1d20] to-[#121214] shadow-[0_30px_90px_-30px_rgba(255,137,117,0.45)]">
        <div className="absolute inset-x-[8%] top-[14%] space-y-[6%]">
          {[72, 64, 80, 58, 70].map((w, i) => (
            <div
              key={w}
              className="h-[3px] rounded-full bg-white/15"
              style={{ width: `${w}%`, opacity: 1 - i * 0.15 }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** The hero canvas: paused off-screen, a still frame for reduced motion, a CSS stand-in without a GPU. */
export function HeroCanvas({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)
  const reduce = useReducedMotion()
  const quality = useQuality()
  // ?still shows the reduced-motion frame without changing OS settings
  const [forceStill, setForceStill] = useState(false)
  useEffect(() => setForceStill(new URLSearchParams(window.location.search).has('still')), [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setActive(!!entry?.isIntersecting), { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      aria-hidden
      className={`relative ${className}`}
      // soft edges, so glow never ends in a hard canvas border
      style={{
        maskImage: 'radial-gradient(ellipse 72% 78% at 50% 50%, #000 62%, transparent 100%)',
        WebkitMaskImage: 'radial-gradient(ellipse 72% 78% at 50% 50%, #000 62%, transparent 100%)',
      }}
    >
      {quality === null || quality === 'none' ? (
        <StillTablet />
      ) : (
        <HeroScene active={active} quality={quality} still={!!reduce || forceStill} />
      )}
    </div>
  )
}
