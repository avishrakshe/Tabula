/**
 * What an agent sees of Tabula: an HTTP API and an API key. No keypairs, no RPC, no wallet.
 */
export interface SessionInfo {
  readonly sessionId: string
  readonly channel: string
  readonly deposit: string
  readonly pricePerCall: string
  readonly unitsPerCall: number
  readonly unitPrice: string
  readonly vendor: { readonly id: string; readonly name: string }
}

export interface PayResult {
  readonly ok: boolean
  readonly status: number
  readonly body: Record<string, unknown>
}

export class GatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async #post(path: string, body: unknown): Promise<PayResult> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { ok: res.ok, status: res.status, body: json }
  }

  async openSession(vendorId: string, taskId: string, opts: { endpoint?: string; taskLabel?: string } = {}) {
    const r = await this.#post('/v1/sessions', { vendorId, taskId, ...opts })
    return { ...r, session: r.ok ? (r.body as unknown as SessionInfo) : null }
  }

  pay(
    session: SessionInfo,
    input: { prompt: string; taskId: string; taskLabel?: string; requestId?: string },
  ) {
    return this.#post(`/v1/sessions/${session.sessionId}/voucher`, {
      units: session.unitsPerCall,
      unitPrice: session.unitPrice,
      ...input,
    })
  }

  closeSession(sessionId: string) {
    return this.#post(`/v1/sessions/${sessionId}/close`, {})
  }

  completeTask(taskId: string, status: 'completed' | 'failed') {
    return this.#post(`/v1/tasks/${encodeURIComponent(taskId)}/complete`, { status })
  }
}
