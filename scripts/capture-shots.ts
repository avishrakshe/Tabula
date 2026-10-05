/**
 * `pnpm tsx scripts/capture-shots.ts` — real dashboard screenshots for the landing page.
 *
 * Drives a headless Chromium (Edge or Chrome, over the DevTools protocol) through the recorded run
 * (`/app?replay&t=…`) on a running dashboard, crops each shot to one dashboard card, and writes
 * JPEGs to apps/web/public/shots/. Re-run after re-recording the demo so the site stays truthful.
 *
 * Needs the web app on http://localhost:3000 (`pnpm --filter @tabula/web build && … start`).
 * Override the browser with TABULA_BROWSER and the app with TABULA_WEB_URL.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, sleep } from './lib/cdp.js'

const WEB = process.env.TABULA_WEB_URL ?? 'http://localhost:3000'
const OUT = join(import.meta.dirname, '..', 'apps', 'web', 'public', 'shots')
const WIDTH = 1440
const HEIGHT = 900

interface Shot {
  name: string
  path: string
  /** seconds into the recording */
  t: number
  /** card titles (h2 text) whose cards are unioned into the crop; omit for the whole viewport */
  cards?: string[]
  /** click the first button with this exact text before capturing, then wait for `waitText` */
  click?: string
  waitText?: string
  maxHeight?: number
}

const SHOTS: Shot[] = [
  { name: 'overview', path: '/app', t: 100 },
  { name: 'feed', path: '/app', t: 100, cards: ['Live vouchers', 'Onchain activity'], maxHeight: 640 },
  { name: 'velocity', path: '/app/agents/rogue-01', t: 75, cards: ['Spend in the trailing window'] },
  { name: 'kill', path: '/app/agents/rogue-01', t: 75, cards: ['Vouchers', 'Timeline'], maxHeight: 620 },
  { name: 'payee', path: '/app/vendors', t: 168, cards: ['Blocked payment requests'] },
  { name: 'scorecards', path: '/app/vendors', t: 168, cards: ['Scorecards'] },
  { name: 'reconcile', path: '/app/reconciliation', t: 168, cards: ['__table__'] },
  {
    name: 'verify',
    path: '/app/ledger',
    t: 168,
    cards: ['Onchain receipts'],
    click: 'Verify',
    waitText: 'hash to the root anchored onchain',
    maxHeight: 520,
  },
]

// union of the cards titled `titles` (or the first card holding a table), in page coordinates
const rectExpr = (titles: string[]) => `(() => {
  const cards = ${JSON.stringify(titles)}.map((title) => title === '__table__'
    ? document.querySelector('main table')?.closest('.rounded-2xl')
    : [...document.querySelectorAll('main h2')].find((h) => h.textContent.trim() === title)?.closest('.rounded-2xl'))
  if (cards.some((c) => !c)) return null
  const rs = cards.map((c) => c.getBoundingClientRect())
  const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top))
  const right = Math.max(...rs.map((r) => r.right)), bottom = Math.max(...rs.map((r) => r.bottom))
  return { x: x + scrollX, y: y + scrollY, width: right - x, height: bottom - y }
})()`

async function main() {
  const res = await fetch(`${WEB}/replay/demo.json`, { method: 'HEAD' }).catch(() => null)
  if (!res?.ok) throw new Error(`no dashboard with a recorded run at ${WEB}`)
  mkdirSync(OUT, { recursive: true })

  const { cdp, stop } = await launch({ width: WIDTH, height: HEIGHT })
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 2,
      mobile: false,
    })

    for (const shot of SHOTS) {
      const url = `${WEB}${shot.path}?replay&t=${shot.t}&theme=dark`
      await cdp.send('Page.navigate', { url })
      await cdp.until(
        `(() => { const r = document.querySelector('[aria-label="Replay position"]')
          return !!r && Number(r.value) === Math.min(${shot.t * 1000}, Number(r.max)) })()`,
        `the replay at ${shot.t}s on ${shot.path}`,
      )
      if (shot.cards) await cdp.until(`${rectExpr(shot.cards)} !== null`, `cards ${shot.cards.join(', ')}`)
      if (shot.click) {
        await cdp.eval(
          `[...document.querySelectorAll('main button')].find((b) => b.textContent.trim() === ${JSON.stringify(shot.click)})?.click()`,
        )
      }
      if (shot.waitText)
        await cdp.until(`document.body.innerText.includes(${JSON.stringify(shot.waitText)})`, shot.waitText)
      await sleep(600) // let charts and fonts settle
      const rect = shot.cards
        ? await cdp.eval<{ x: number; y: number; width: number; height: number }>(rectExpr(shot.cards))
        : { x: 0, y: 0, width: WIDTH, height: HEIGHT }
      const clip = {
        ...rect,
        height: Math.min(rect.height, shot.maxHeight ?? Number.POSITIVE_INFINITY),
        scale: 1,
      }
      const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 88,
        clip,
        captureBeyondViewport: true,
      })
      const file = join(OUT, `${shot.name}.jpg`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      console.log(
        `${shot.name.padEnd(11)} ${Math.round(clip.width * 2)}x${Math.round(clip.height * 2)}  ${url}`,
      )
    }
    cdp.close()
  } finally {
    await stop()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
