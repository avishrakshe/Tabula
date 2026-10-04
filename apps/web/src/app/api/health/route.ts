import { injectGateway } from '@/server/inject'

export const GET = (req: Request) => injectGateway(req, '/health')
