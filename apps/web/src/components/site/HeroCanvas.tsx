'use client'

import { useReducedMotion } from 'motion/react'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useRef, useState } from 'react'

const HeroScene = dynamic(() => import('./HeroScene'), { ssr: false })

type Quality = 'none' | 'low' | 'high'

/**
 * True once the page has loaded and the browser is idle: the scene (three.js and its startup work)
 * waits until the page itself is interactive. Until then the CSS stand-in shows.
 */
function useIdleStart(delayMs = 700): boolean {
  const [go, setGo] = useState(false)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let idle: number | undefined
    const start = () => {
      timer = setTimeout(() => {
        const done = () => !cancelled && setGo(true)
        if ('requestIdleCallback' in window) idle = window.requestIdleCallback(done, { timeout: 2000 })
        else done()
      }, delayMs)
    }
    if (document.readyState === 'complete') start()
    else window.addEventListener('load', start, { once: true })
    return () => {
      cancelled = true
      window.removeEventListener('load', start)
      if (timer) clearTimeout(timer)
      if (idle !== undefined && 'cancelIdleCallback' in window) window.cancelIdleCallback(idle)
    }
  }, [delayMs])
  return go
}

/**
 * Picks a quality tier from detect-gpu (benchmarks served from /gpu), defaulting to low.
 * `?quality=high|low|none` overrides it (embeds, and checking the scene on any machine).
 */
function useQuality(enabled: boolean): Quality | null {
  const [quality, setQuality] = useState<Quality | null>(null)
  useEffect(() => {
    if (!enabled) return
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
  }, [enabled])
  return quality
}

/** The CSS stand-in: shown until the scene is ready, and instead of it on devices without a usable GPU. */
export function StillTablet() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative -mt-[6%] aspect-[3/2] w-[min(40%,470px)] rounded-[12px] border border-white/10 bg-linear-to-b from-[#232326] to-[#141416] shadow-[0_30px_90px_-30px_rgba(255,137,117,0.45)]">
        <div className="absolute inset-x-[7%] top-[16%] space-y-[5%]">
          {[72, 64, 80, 58, 70, 62].map((w, i) => (
            <div
              key={w}
              className="h-[3px] rounded-full bg-white/15"
              style={{ width: `${w}%`, opacity: 1 - i * 0.13 }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** The hero canvas: started once the page is idle, paused off-screen, still for reduced motion. */
export function HeroCanvas({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)
  const [ready, setReady] = useState(false)
  const reduce = useReducedMotion()
  const go = useIdleStart()
  const quality = useQuality(go)
  // ?still shows the reduced-motion frame without changing OS settings
  const [forceStill, setForceStill] = useState(false)
  useEffect(() => setForceStill(new URLSearchParams(window.location.search).has('still')), [])
  const onReady = useCallback(() => setReady(true), [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setActive(!!entry?.isIntersecting), { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const scene = quality === 'low' || quality === 'high'
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
      <div className={`transition-opacity duration-700 ${scene && ready ? 'opacity-0' : 'opacity-100'}`}>
        <StillTablet />
      </div>
      {scene ? (
        <div
          className={`absolute inset-0 transition-opacity duration-1000 ${ready ? 'opacity-100' : 'opacity-0'}`}
        >
          <HeroScene active={active} quality={quality} still={!!reduce || forceStill} onReady={onReady} />
        </div>
      ) : null}
    </div>
  )
}
