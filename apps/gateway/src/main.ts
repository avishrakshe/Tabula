import { buildApp } from './app.js'
import { configFromEnv } from './config.js'
import { createGateway } from './gateway.js'

const config = configFromEnv()
const gw = await createGateway(config)
const app = await buildApp(gw)
await app.listen({ port: config.port, host: config.host })
console.log(
  `[gateway] listening on http://${config.host}:${config.port}  cluster=${config.cluster.name}  db=${config.dbPath}`,
)
console.log(`[gateway] treasury=${gw.treasury.kind}  restored ${gw.sessions.sessions().length} session(s)`)

// float manager: close idle channels and sweep idle wallets back to the treasury vault
const sweeper =
  config.idleSweepMs > 0
    ? setInterval(() => {
        gw.sessions.sweepIdle().catch((err) => console.error('[gateway] idle sweep failed:', err))
      }, config.idleSweepMs)
    : null

const shutdown = async () => {
  if (sweeper) clearInterval(sweeper)
  await app.close()
  await gw.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
