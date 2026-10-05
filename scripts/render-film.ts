/**
 * `pnpm film:render [out.mp4]` — renders the Tabula film to an MP4: 1920×1080, 30 fps, H.264.
 *
 * The film is a pure function of time, so this steps it one frame at a time on a running site
 * (`/film/render` exposes `window.__film`), captures each frame over the DevTools protocol and pipes
 * it to ffmpeg. The MP4 matches what plays on the site, frame for frame, however slow the machine.
 *
 * Needs ffmpeg (on PATH, or FFMPEG=<path>) and the web app on http://localhost:3000 (TABULA_WEB_URL):
 * `pnpm --filter @tabula/web build && pnpm --filter @tabula/web start`. Writes
 * apps/web/public/film/tabula-film.mp4 by default; the /film page offers it for download when present.
 * Options (env): FPS (30), CRF (20; lower is larger and sharper).
 */
import { spawn } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { launch } from './lib/cdp.js'

const WEB = process.env.TABULA_WEB_URL ?? 'http://localhost:3000'
const OUT = resolve(
  process.argv[2] ?? join(import.meta.dirname, '..', 'apps', 'web', 'public', 'film', 'tabula-film.mp4'),
)
const FPS = Number(process.env.FPS ?? 30)
const CRF = Number(process.env.CRF ?? 20)
const WIDTH = 1920
const HEIGHT = 1080

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)
    }),
  ])
}

async function main() {
  const res = await fetch(`${WEB}/film/render`, { method: 'HEAD' }).catch(() => null)
  if (!res?.ok) throw new Error(`no film at ${WEB}/film/render: start the web app first`)
  mkdirSync(dirname(OUT), { recursive: true })

  const { cdp, stop } = await launch({ width: WIDTH, height: HEIGHT, port: 9334 })
  const ffmpeg = spawn(
    process.env.FFMPEG ?? 'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      '-framerate',
      String(FPS),
      '-i',
      '-',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      String(CRF),
      // the captured JPEGs are full range; players expect limited-range BT.709 (else Safari washes it out)
      '-vf',
      'scale=in_range=pc:out_range=tv,format=yuv420p',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-movflags',
      '+faststart',
      OUT,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  )
  const encoded = new Promise<void>((ok, fail) => {
    ffmpeg.on('error', (err) => fail(new Error(`could not run ffmpeg (${err.message}); set FFMPEG`)))
    ffmpeg.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited with ${code}`))))
  })

  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await cdp.send('Page.navigate', { url: `${WEB}/film/render` })
    await cdp.until('!!window.__film && document.body.dataset.filmReady === "1"', 'the film to load', 60_000)
    const duration = await cdp.eval<number>('window.__film.duration')
    const frames = Math.round((duration / 1000) * FPS)
    const started = Date.now()
    for (let i = 0; i <= frames; i++) {
      // a frame that hangs fails the render loudly instead of stalling it
      const data = await withTimeout(
        (async () => {
          await cdp.eval(`window.__film.seek(${(i * 1000) / FPS})`)
          const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', {
            format: 'jpeg',
            quality: 95,
          })
          return shot.data
        })(),
        30_000,
        `frame ${i}`,
      )
      if (!ffmpeg.stdin.write(Buffer.from(data, 'base64')))
        await new Promise((r) => ffmpeg.stdin.once('drain', r))
      if (i % (FPS * 5) === 0) {
        const pct = Math.round((i / frames) * 100)
        console.log(`frame ${i}/${frames} (${pct}%)  ${Math.round((Date.now() - started) / 1000)}s`)
      }
    }
    ffmpeg.stdin.end()
    await encoded
    cdp.close()
  } catch (err) {
    ffmpeg.kill()
    throw err
  } finally {
    await stop()
  }
  console.log(`\n${OUT}  ${(statSync(OUT).size / 1e6).toFixed(1)} MB`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
