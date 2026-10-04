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
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WEB = process.env.TABULA_WEB_URL ?? 'http://localhost:3000'
const OUT = join(import.meta.dirname, '..', 'apps', 'web', 'public', 'shots')
const PORT = 9333
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

function browserPath(): string {
  const candidates = [
    process.env.TABULA_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  const found = candidates.find((p) => p && existsSync(p))
  if (!found) throw new Error('no Chromium-based browser found; set TABULA_BROWSER')
  return found
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Cdp {
  #ws: WebSocket
  #id = 0
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  private constructor(ws: WebSocket) {
    this.#ws = ws
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number
        result?: unknown
        error?: { message: string }
      }
      if (msg.id === undefined) return
      const p = this.#pending.get(msg.id)
      if (!p) return
      this.#pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    })
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), { once: true })
    })
    return new Cdp(ws)
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.#id
    this.#ws.send(JSON.stringify({ id, method, params }))
    return new Promise<T>((resolve, reject) => this.#pending.set(id, { resolve: resolve as never, reject }))
  }

  async eval<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
    )
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }

  async until(expression: string, what: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.eval<boolean>(expression).catch(() => false)) return
      await sleep(200)
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  close() {
    this.#ws.close()
  }
}

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

  const profile = mkdtempSync(join(tmpdir(), 'tabula-shots-'))
  const browser = spawn(
    browserPath(),
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${WIDTH},${HEIGHT}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  try {
    let target: { webSocketDebuggerUrl: string } | null = null
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200)
      target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
        .then((r) => (r.ok ? (r.json() as Promise<{ webSocketDebuggerUrl: string }>) : null))
        .catch(() => null)
    }
    if (!target) throw new Error('the headless browser did not start')
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
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
    browser.kill()
    await sleep(500)
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
