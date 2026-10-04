import { DEMO_VENDORS } from '@tabula/vendor-mock'
import { hostedVendor } from '@/server/gateway'

// a seeded "timeout" call hangs past the gateway's patience; opens wait for a confirmation
export const maxDuration = 60

/** The hosted demo vendors: the unmodified @solana/mpp session server, state in Postgres. */
const handle = async (req: Request, ctx: { params: Promise<{ id: string; path: string[] }> }) => {
  const { id } = await ctx.params
  if (!DEMO_VENDORS.some((v) => v.id === id))
    return Response.json({ error: 'unknown vendor' }, { status: 404 })
  const { app } = await hostedVendor(id)
  return app.fetch(req)
}

export { handle as GET, handle as POST }
