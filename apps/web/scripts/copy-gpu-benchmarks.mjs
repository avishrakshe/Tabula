// Serve detect-gpu's benchmark tables from our own origin (public/gpu/) instead of its default CDN.
import { cpSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const from = join(dirname(require.resolve('detect-gpu/package.json')), 'dist', 'benchmarks')
const to = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'gpu')
mkdirSync(to, { recursive: true })
cpSync(from, to, { recursive: true })
console.log(`detect-gpu benchmarks -> ${to}`)
