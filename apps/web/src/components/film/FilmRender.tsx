'use client'

import { useEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { FilmStage, STAGE_H, STAGE_W } from './FilmStage'
import { captions as captionsFor, DURATION, type FilmFacts } from './timeline'

declare global {
  interface Window {
    /** scripts/render-film.ts steps the film through this, one frame at a time */
    __film?: { duration: number; seek(t: number): Promise<void> }
  }
}

/** The bare stage filling the viewport, for frame capture: no controls, no clock of its own. */
export function FilmRender({ facts }: { facts: FilmFacts }) {
  const caps = useMemo(() => captionsFor(facts), [facts])
  const [t, setT] = useState(0)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H))
    fit()
    window.addEventListener('resize', fit)
    window.__film = {
      duration: DURATION,
      // renders the frame for `ms` before returning; the capture that follows paints it. (Waiting on
      // requestAnimationFrame instead can stall a headless browser for good.)
      seek: (ms) => {
        flushSync(() => setT(ms))
        return Promise.resolve()
      },
    }
    void document.fonts.ready.then(() => {
      document.body.dataset.filmReady = '1'
    })
    return () => window.removeEventListener('resize', fit)
  }, [])
  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <div style={{ transform: `scale(${scale})`, transformOrigin: '0 0', width: STAGE_W, height: STAGE_H }}>
        <FilmStage t={t} facts={facts} captions={caps} />
      </div>
    </div>
  )
}
