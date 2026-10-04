import { injectGateway } from '@/server/inject'

// a voucher round trip is one vendor call; a close can wait on a few confirmations
export const maxDuration = 60

const handle = async (req: Request, ctx: { params: Promise<{ path: string[] }> }) =>
  injectGateway(req, `/v1/${(await ctx.params).path.join('/')}`)

export { handle as DELETE, handle as GET, handle as POST, handle as PUT }
