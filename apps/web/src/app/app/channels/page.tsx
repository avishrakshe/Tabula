'use client'

import { Landmark } from 'lucide-react'
import { useState } from 'react'
import {
  Addr,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ExplorerLink,
  Kpi,
  PageHeader,
  Table,
  Td,
  Th,
} from '@/components/ui'
import { useTabula } from '@/lib/data/provider'
import { duration, timeAgo, usd } from '@/lib/format'

export default function ChannelsPage() {
  const { data, actions, mode, now } = useTabula()
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const f = data.float
  const closed = data.channels.filter((c) => c.status === 'refunded' || c.status === 'sealed')

  return (
    <>
      <PageHeader
        title="Channels & float"
        description="Money in escrow is money not in the treasury. Tabula sizes each deposit from the onchain allowance and past usage, and reclaims escrow from channels that go idle."
        actions={
          <Button
            variant="primary"
            disabled={mode !== 'live' || busy}
            title={mode !== 'live' ? 'Connect a live gateway to act' : undefined}
            onClick={async () => {
              setBusy(true)
              setMsg(null)
              try {
                const r = await actions.sweepIdle()
                setMsg(`Reclaimed ${usd(r.reclaimed)} of idle escrow and float.`)
              } catch (err) {
                setMsg((err as Error).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            <Landmark className="size-4" /> {busy ? 'Sweeping…' : 'Sweep idle'}
          </Button>
        }
      />
      {msg ? <p className="mb-4 rounded-xl border border-line bg-surface px-4 py-2 text-sm">{msg}</p> : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Treasury vault"
          value={usd(f?.treasury.balance ?? null)}
          hint={f?.treasury.kind === 'squads-allowance' ? 'Squads v4 vault' : 'sandbox faucet'}
        />
        <Kpi
          label="Escrow tied up"
          value={usd(f?.escrowTiedUp ?? 0)}
          hint={`${f?.channels.length ?? 0} open channels`}
        />
        <Kpi label="Reclaimed this week" value={usd(data.overview?.escrowReclaimedThisWeek ?? 0)} />
        <Kpi
          label="Swept to the vault"
          value={usd(data.overview?.sweptToVaultThisWeek ?? 0)}
          hint="this week"
        />
      </div>
      {f?.treasury.vault ? (
        <p className="mt-3 text-xs text-fg-2">
          Vault <Addr value={f.treasury.vault} n={6} />
        </p>
      ) : null}

      <Card className="mt-6">
        <CardHeader title="Escrow by vendor" />
        {(f?.byVendor.length ?? 0) === 0 ? (
          <EmptyState title="No open channels">
            Agents open a channel the first time they pay a vendor.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Vendor</Th>
                <Th className="text-right">Channels</Th>
                <Th className="text-right">Deposited</Th>
                <Th className="text-right">Used</Th>
                <Th className="text-right">Idle escrow</Th>
              </tr>
            </thead>
            <tbody>
              {f!.byVendor.map((v) => (
                <tr key={v.vendorId}>
                  <Td className="font-medium">{v.vendorId}</Td>
                  <Td className="num text-right">{v.channels}</Td>
                  <Td className="num text-right">{usd(v.deposit)}</Td>
                  <Td className="num text-right">{usd(v.used)}</Td>
                  <Td className="num text-right">{usd(v.idleEscrow)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader title="Open channels" />
        {(f?.channels.length ?? 0) === 0 ? (
          <EmptyState title="Nothing in escrow right now" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Channel</Th>
                <Th>Agent → vendor</Th>
                <Th className="text-right">Deposit</Th>
                <Th className="text-right">Used</Th>
                <Th className="text-right">Idle</Th>
              </tr>
            </thead>
            <tbody>
              {f!.channels.map((c) => (
                <tr key={c.sessionId}>
                  <Td>
                    <Addr value={c.channel} href={c.explorerUrl} />
                  </Td>
                  <Td>
                    {c.agentId} → {c.vendorId}
                  </Td>
                  <Td className="num text-right">{usd(c.deposit)}</Td>
                  <Td className="num text-right">{usd(c.used)}</Td>
                  <Td className="num text-right">{duration(c.idleMs)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader
          title="Closed channels"
          subtitle="Settled amount onchain and what came back to the agent wallet."
        />
        {closed.length === 0 ? (
          <EmptyState title="No closed channels yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Channel</Th>
                <Th>Agent → vendor</Th>
                <Th>Why</Th>
                <Th className="text-right">Deposit</Th>
                <Th className="text-right">Settled</Th>
                <Th className="text-right">Refunded</Th>
                <Th>Closed</Th>
              </tr>
            </thead>
            <tbody>
              {closed.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Addr value={c.channelPda} />
                  </Td>
                  <Td>
                    {c.agentId} → {c.vendorId}
                  </Td>
                  <Td className="max-w-[28ch] text-xs text-fg-2">
                    {c.closeReason?.startsWith('killed') ? <Badge tone="sever">stopped</Badge> : null}{' '}
                    {c.closeReason}
                  </Td>
                  <Td className="num text-right">{usd(c.deposit)}</Td>
                  <Td className="num text-right">{usd(c.settledAmount)}</Td>
                  <Td className="num text-right">{usd(c.refundedAmount)}</Td>
                  <Td className="text-xs text-fg-2">
                    {c.closeTx ? (
                      <ExplorerLink
                        href={data.timeline.find((t) => t.txSignature === c.closeTx)?.explorerUrl ?? null}
                      >
                        {timeAgo(c.closedAt, now)}
                      </ExplorerLink>
                    ) : (
                      timeAgo(c.closedAt, now)
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  )
}
