import type { Address } from '@solana/kit'
import { TOKEN_PROGRAM } from './cluster'

/**
 * Surfnet cheatcodes, available only on the Solana Payment Sandbox and local surfpool.
 * Same calls pay-kit's playground uses (typescript/examples/playground-api/sandbox.ts).
 * They write account state directly: no real funds exist anywhere in this flow.
 */
const SYSTEM_PROGRAM = '11111111111111111111111111111111'

export async function surfnetRpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

/** Sets an address's SOL balance (system-owned, no data). */
export async function setSolBalance(rpcUrl: string, owner: Address, lamports: bigint): Promise<void> {
  await surfnetRpc(rpcUrl, 'surfnet_setAccount', [
    owner,
    { lamports: Number(lamports), data: '', executable: false, owner: SYSTEM_PROGRAM, rentEpoch: 0 },
  ])
}

/** Sets the balance of `owner`'s associated token account for `mint` (creates it if missing). */
export async function setTokenBalance(
  rpcUrl: string,
  owner: Address,
  mint: Address,
  amount: bigint,
  tokenProgram: Address = TOKEN_PROGRAM,
): Promise<void> {
  await surfnetRpc(rpcUrl, 'surfnet_setTokenAccount', [
    owner,
    mint,
    { amount: Number(amount), state: 'initialized' },
    tokenProgram,
  ])
}
