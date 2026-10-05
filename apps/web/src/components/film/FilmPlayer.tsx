'use client'

import { ArrowRight, Captions, Download, Maximize, Minimize, Pause, Play, RotateCcw } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FilmStage, STAGE_H, STAGE_W, serifClass } from './FilmStage'
import {
  CHAPTERS,
  captions as captionsFor,
  chapterAt,
  DURATION,
  easeOut,
  type FilmFacts,
  POSTER_T,
  prog,
} from './timeline'

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Stage scale for the frame's current width (the stage is drawn at 1600×900). */
function useStageScale() {
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState<number | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const box = entry!.contentRect
      setScale(Math.min(box.width / STAGE_W, box.height / STAGE_H))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, scale }
}

/** The end card's buttons, live on top of the drawn ones, in stage coordinates. */
function EndCtas({ t, waitlistHref }: { t: number; waitlistHref: string }) {
  const p = easeOut(prog(t, 75_600, 76_300))
  if (p <= 0) return null
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 518,
        display: 'flex',
        justifyContent: 'center',
        gap: 14,
        opacity: p,
        transform: `translateY(${(1 - p) * 22}px)`,
      }}
    >
      <a
        href={waitlistHref}
        className="rounded-full bg-wax px-7 py-3.5 text-[20px] font-medium text-ink hover:bg-paper"
        onClick={(e) => e.stopPropagation()}
      >
        Join the waitlist →
      </a>
      <a
        href="/app"
        className="rounded-full border border-white/25 px-7 py-3.5 text-[20px] text-paper hover:border-white/60"
        onClick={(e) => e.stopPropagation()}
      >
        Open the live dashboard
      </a>
    </div>
  )
}

export function FilmPlayer({
  facts,
  waitlistHref = '#waitlist',
  mp4,
  autoplay = true,
}: {
  facts: FilmFacts
  waitlistHref?: string
  /** a rendered copy to download, when one ships with the site */
  mp4?: string
  autoplay?: boolean
}) {
  const caps = useMemo(() => captionsFor(facts), [facts])
  const reduce = useReducedMotion()
  const { ref: frameRef, scale } = useStageScale()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [t, setT] = useState(POSTER_T)
  const [playing, setPlaying] = useState(false)
  const [started, setStarted] = useState(false)
  const [cc, setCc] = useState(true)
  const [full, setFull] = useState(false)
  // the clock lives in a ref too, so the frame loop and the controls never read a stale time
  const time = useRef(POSTER_T)
  const startedRef = useRef(false)
  // once the viewer pauses, scrolling never restarts it
  const userPaused = useRef(false)

  const setTime = useCallback((ms: number) => {
    time.current = Math.max(0, Math.min(DURATION, ms))
    setT(time.current)
  }, [])
  const begin = useCallback(() => {
    if (startedRef.current) return false
    startedRef.current = true
    setStarted(true)
    return true
  }, [])
  const play = useCallback(() => {
    // the first play starts from the top (the poster is a frame from the middle)
    if (begin() || time.current >= DURATION) setTime(0)
    setPlaying(true)
  }, [begin, setTime])
  const pause = useCallback(() => {
    userPaused.current = true
    setPlaying(false)
  }, [])
  const toggle = useCallback(() => (playing ? pause() : play()), [playing, pause, play])
  const seek = useCallback(
    (ms: number) => {
      begin()
      setTime(ms)
    },
    [begin, setTime],
  )

  // the clock: requestAnimationFrame while playing; a hidden tab simply stops getting frames
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min(100, now - last)
      last = now
      setTime(time.current + dt)
      if (time.current >= DURATION) setPlaying(false)
      else raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, setTime])

  // autoplay when mostly on screen (never with reduced motion), pause when it scrolls away
  useEffect(() => {
    const el = wrapRef.current
    if (!el || !autoplay) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return
        if (entry.intersectionRatio >= 0.5) {
          if (!reduce && !userPaused.current) play()
        } else if (entry.intersectionRatio < 0.15) {
          setPlaying(false)
        }
      },
      { threshold: [0, 0.15, 0.5, 1] },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [autoplay, reduce, play])

  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === wrapRef.current)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void wrapRef.current?.requestFullscreen?.()
  }

  const ended = t >= DURATION
  const { index } = chapterAt(t)
  // on a phone the drawn captions would be a few pixels tall: show them under the picture instead
  const tiny = scale !== null && scale < 0.42
  const caption = caps.find((c) => t >= c.at && t <= c.to)
  const stageStyle: CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: STAGE_W,
    height: STAGE_H,
    transform: `translate(-50%, -50%) scale(${scale ?? 0.5})`,
    opacity: scale === null ? 0 : 1,
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: shortcuts (K, C, F, arrows) for the player's own buttons; key presses bubble up from them
    <div
      ref={wrapRef}
      className={full ? 'flex h-full flex-col justify-center bg-black p-4' : ''}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement && e.key.startsWith('Arrow')) return
        const k = e.key.toLowerCase()
        if (k === 'k') toggle()
        else if (k === 'c') setCc((v) => !v)
        else if (k === 'f') toggleFull()
        else if (k === 'arrowright') seek(t + 5_000)
        else if (k === 'arrowleft') seek(t - 5_000)
        else return
        e.preventDefault()
      }}
    >
      <div
        ref={frameRef}
        className={`relative w-full overflow-hidden bg-[#0b0b0b] ${full ? 'mx-auto max-h-[calc(100vh-120px)] flex-1' : 'aspect-video rounded-[22px] border border-white/10 shadow-[0_40px_140px_-50px_rgba(255,137,117,0.45)]'}`}
        style={full ? { aspectRatio: '16 / 9' } : undefined}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a click on the picture toggles playback, like any video; the buttons below are the keyboard controls */}
        <div className="absolute inset-0 cursor-pointer" onClick={toggle}>
          <div style={stageStyle}>
            <div aria-hidden>
              <FilmStage t={t} facts={facts} captions={caps} showCaptions={cc && !tiny} ctas={false} />
            </div>
            <EndCtas t={t} waitlistHref={waitlistHref} />
          </div>
        </div>
        {!started ? (
          <button
            type="button"
            onClick={play}
            className="group absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/45 text-paper"
            aria-label={`Play the film, ${clock(DURATION)}`}
          >
            <span className="flex size-20 items-center justify-center rounded-full bg-wax text-ink shadow-[0_0_80px_-10px_rgba(255,137,117,0.8)] transition-transform group-hover:scale-105">
              <Play aria-hidden className="ml-1 size-8" fill="currentColor" />
            </span>
            <span className="text-sm tracking-[0.14em] text-paper/90 uppercase">
              Play the film · {clock(DURATION)}
            </span>
          </button>
        ) : null}
      </div>

      {cc && tiny ? (
        <p aria-hidden className="mt-3 min-h-[2.9em] text-center text-[15px] leading-snug text-paper">
          {caption?.text.split('*').map((part, i) =>
            i % 2 ? (
              <span key={part} className={`${serifClass} text-[17px] text-wax`}>
                {part}
              </span>
            ) : (
              part
            ),
          )}
        </p>
      ) : null}

      {/* controls */}
      <div
        className={`mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 ${full ? 'mx-auto w-full max-w-[1400px]' : ''}`}
      >
        <button
          type="button"
          onClick={ended ? play : toggle}
          aria-label={ended ? 'Watch again' : playing ? 'Pause' : 'Play'}
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-paper text-ink transition-colors hover:bg-wax"
        >
          {ended ? (
            <RotateCcw aria-hidden className="size-4" />
          ) : playing ? (
            <Pause aria-hidden className="size-4" fill="currentColor" />
          ) : (
            <Play aria-hidden className="ml-0.5 size-4" fill="currentColor" />
          )}
        </button>
        <span className="num w-[92px] shrink-0 text-sm text-gray-1">
          {clock(t)} / {clock(DURATION)}
        </span>
        <div className="relative order-first h-10 w-full sm:order-none sm:w-auto sm:min-w-0 sm:flex-1">
          {/* chapter segments under the native range input */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-1/2 flex h-1.5 -translate-y-1/2 gap-[3px]"
          >
            {CHAPTERS.map((c) => {
              const fill = prog(t, c.start, c.end)
              return (
                <div
                  key={c.id}
                  className="relative h-full overflow-hidden rounded-full bg-white/15"
                  style={{ flexGrow: c.end - c.start }}
                >
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-wax"
                    style={{ width: `${fill * 100}%` }}
                  />
                </div>
              )
            })}
          </div>
          <input
            type="range"
            min={0}
            max={DURATION}
            step={100}
            value={Math.round(t)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Film position"
            aria-valuetext={`${clock(t)}, ${CHAPTERS[index]?.label}`}
            className="film-range absolute inset-0 w-full cursor-pointer"
          />
        </div>
        <button
          type="button"
          onClick={() => setCc((v) => !v)}
          aria-pressed={cc}
          aria-label="Captions"
          title="Captions (C)"
          className={`ml-auto flex size-10 shrink-0 items-center justify-center rounded-full transition-colors sm:ml-0 ${cc ? 'bg-white/12 text-paper' : 'text-gray-1 hover:text-paper'}`}
        >
          <Captions aria-hidden className="size-5" />
        </button>
        {mp4 ? (
          <a
            href={mp4}
            download
            aria-label="Download the film (MP4)"
            title="Download (MP4)"
            className="hidden size-10 shrink-0 items-center justify-center rounded-full text-gray-1 transition-colors hover:text-paper sm:flex"
          >
            <Download aria-hidden className="size-5" />
          </a>
        ) : null}
        <button
          type="button"
          onClick={toggleFull}
          aria-label={full ? 'Exit full screen' : 'Full screen'}
          title="Full screen (F)"
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-gray-1 transition-colors hover:text-paper"
        >
          {full ? <Minimize aria-hidden className="size-5" /> : <Maximize aria-hidden className="size-5" />}
        </button>
      </div>

      {/* chapters */}
      {!full ? (
        <ol className="mt-5 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] md:flex-wrap md:overflow-visible">
          {CHAPTERS.slice(1, -1).map((c, i) => {
            const active = index === i + 1
            return (
              <li key={c.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    seek(c.start)
                    play()
                  }}
                  aria-current={active ? 'step' : undefined}
                  className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm whitespace-nowrap transition-colors ${active ? 'border-wax/60 bg-wax/12 text-paper' : 'border-white/10 text-gray-1 hover:border-white/30 hover:text-paper'}`}
                >
                  <span className="num text-xs text-wax">{String(i + 1).padStart(2, '0')}</span>
                  {c.label}
                </button>
              </li>
            )
          })}
          <li className="shrink-0">
            <a
              href={waitlistHref}
              className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm whitespace-nowrap text-gray-1 hover:text-paper"
            >
              Get early access <ArrowRight aria-hidden className="size-3.5" />
            </a>
          </li>
        </ol>
      ) : null}
      {!full ? (
        <details className="group mt-4 text-sm text-gray-1">
          <summary className="w-fit cursor-pointer list-none hover:text-paper [&::-webkit-details-marker]:hidden">
            <span className="underline decoration-white/25 underline-offset-4 group-open:decoration-wax">
              Read the transcript
            </span>
          </summary>
          <ol className="mt-3 max-w-[70ch] space-y-1.5">
            {caps.map((c) => (
              <li key={c.at} className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    seek(c.at)
                    play()
                  }}
                  className="num shrink-0 text-wax hover:underline"
                >
                  {clock(c.at)}
                </button>
                <span>{c.text.replaceAll('*', '')}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  )
}
