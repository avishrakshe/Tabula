import { ImageResponse } from 'next/og'

export const alt = 'Tabula — Every agent payment, accounted for'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const ROWS: { text: string; tone: 'pay' | 'blocked' | 'note' }[] = [
  { text: 'coder-01    → inference-a   $0.001    Σ $0.061', tone: 'pay' },
  { text: 'BLOCKED  rogue-01 → inference-b   velocity limit', tone: 'blocked' },
  { text: 'rogue-01 stopped · channel closed · refund to vault', tone: 'note' },
  { text: 'batch #7 anchored onchain · 4/4 channels MATCHED', tone: 'pay' },
]

export default function Image() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 72,
        background: 'radial-gradient(circle at 50% -10%, rgba(255,137,117,0.35), #141414 60%)',
        color: '#ffffff',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 30, fontWeight: 600 }}>
        <div style={{ width: 14, height: 14, borderRadius: 7, background: '#ff8975' }} />
        Tabula
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ fontSize: 68, lineHeight: 1.08, letterSpacing: -2, maxWidth: 900 }}>
          Every agent payment, accounted for.
        </div>
        <div style={{ fontSize: 28, color: '#acafb9', maxWidth: 900 }}>
          Spend control and treasury for AI agents that pay through Solana payment channels.
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '22px 28px',
          borderRadius: 20,
          border: '1px solid rgba(255,255,255,0.12)',
          background: 'rgba(28,28,28,0.9)',
          fontFamily: 'monospace',
          fontSize: 20,
        }}
      >
        {ROWS.map((r) => (
          <div
            key={r.text}
            style={{
              display: 'flex',
              color: r.tone === 'blocked' ? '#ff5a4a' : r.tone === 'note' ? '#ffaa96' : '#d8d6d2',
            }}
          >
            {r.text}
          </div>
        ))}
      </div>
    </div>,
    size,
  )
}
