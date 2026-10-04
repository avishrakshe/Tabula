/**
 * The gateway inside the web app's serverless functions. One instance per function instance, created on
 * first use and reused while the instance lives. Every instance shares the one Postgres database, and the
 * gateway is built for that (per-agent transaction locks, claimed closes, on-demand session loading).
 *
 * The HTTP API is the gateway's own Fastify app driven through `inject`, so the routes, auth and validation
 * are the same code `pnpm demo` serves locally; only the transport differs.
 */
import { buildApp, configFromEnv, createGateway, type Gateway } from '@tabula/gateway'
import { createHostedVendor, demoVendor } from '@tabula/vendor-mock'
import type { FastifyInstance } from 'fastify'

interface Runtime {
  readonly gw: Gateway
  readonly app: FastifyInstance
}

let runtime: Promise<Runtime> | null = null

export function gateway(): Promise<Runtime> {
  runtime ??= (async () => {
    const config = { ...configFromEnv(), serverless: true }
    if (!/^postgres(ql)?:\/\//.test(config.dbPath))
      throw new Error('the hosted gateway needs DATABASE_URL (Supabase, transaction pooler)')
    const gw = await createGateway(config)
    const app = await buildApp(gw)
    await app.ready()
    return { gw, app }
  })().catch((err) => {
    runtime = null // let the next request try again
    throw err
  })
  return runtime
}

const vendors = new Map<string, Promise<{ app: { fetch: (req: Request) => Response | Promise<Response> } }>>()

/** A hosted demo vendor (`/api/vendors/<id>/…`): its own keys, its session state in the shared database. */
export function hostedVendor(id: string) {
  let v = vendors.get(id)
  if (!v) {
    v = (async () => {
      const { gw } = await gateway()
      return createHostedVendor(demoVendor(id), gw.config.cluster, gw.config.mint, {
        db: gw.ledger.db,
        basePath: `/api/vendors/${id}`,
      })
    })().catch((err) => {
      vendors.delete(id)
      throw err
    })
    vendors.set(id, v)
  }
  return v
}
