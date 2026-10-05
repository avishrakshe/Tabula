/**
 * A headless Chromium (Edge or Chrome) driven over the DevTools protocol, for the scripts that capture
 * the site: screenshots (capture-shots.ts) and the film (render-film.ts). No browser automation
 * dependency: just the browser the machine already has and its WebSocket protocol.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function browserPath(): string {
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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Cdp {
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

/**
 * Starts a headless browser with a throwaway profile and connects to a blank page in it. `stop()` closes
 * the browser and removes the profile.
 */
export async function launch(opts: { width: number; height: number; port?: number }) {
  const port = opts.port ?? 9333
  const profile = mkdtempSync(join(tmpdir(), 'tabula-cdp-'))
  const browser = spawn(
    browserPath(),
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${opts.width},${opts.height}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const stop = async () => {
    browser.kill()
    await sleep(500)
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  try {
    let target: { webSocketDebuggerUrl: string } | null = null
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200)
      target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
        .then((r) => (r.ok ? (r.json() as Promise<{ webSocketDebuggerUrl: string }>) : null))
        .catch(() => null)
    }
    if (!target) throw new Error('the headless browser did not start')
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    return { cdp, stop }
  } catch (err) {
    await stop()
    throw err
  }
}
