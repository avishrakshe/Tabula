'use client'

import { OctagonX, RotateCcw } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { AgentStatusBadge, Button, Card, EmptyState, Meter, PageHeader, Table, Td, Th } from '@/components/ui'
import { useTabula } from '@/lib/data/provider'
import { timeAgo, usd } from '@/lib/format'

export default function AgentsPage() {
  const { data, actions, canAct, actHint, now } = useTabula()
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000

  const run = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(id)
    setMessage(null)
    try {
      await fn()
      setMessage(done)
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusy(null)
      setConfirm(null)
    }
  }

  return (
    <>
      <PageHeader
        title="Agents"
        description="Each agent pays with an API key only. Tabula holds its wallet and voucher key, checks every voucher against policy, and draws escrow from the treasury through an onchain allowance."
      />
      {message ? (
        <p className="mb-4 rounded-xl border border-line bg-surface px-4 py-2 text-sm">{message}</p>
      ) : null}
      <Card>
        {data.agents.length === 0 ? (
          <EmptyState title="No agents registered">
            Run <code className="font-mono">pnpm setup</code> to create the treasury vault, agent wallets and
            allowances, then <code className="font-mono">pnpm demo</code>.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Agent</Th>
                <Th>Status</Th>
                <Th>Spent today</Th>
                <Th>Onchain allowance</Th>
                <Th>Open channels</Th>
                <Th>Last payment</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((a) => {
                const mine = data.vouchers.filter((v) => v.agentId === a.id)
                const spent = mine
                  .filter((v) => v.verdict === 'signed' && v.ts >= dayStart)
                  .reduce((s, v) => s + v.delta, 0)
                const open = data.channels.filter((c) => c.agentId === a.id && c.status === 'open').length
                const last = mine[0]?.ts
                return (
                  <tr key={a.id} className="hover:bg-surface-2/60">
                    <Td>
                      <Link href={`/app/agents/${a.id}`} className="font-medium hover:underline">
                        {a.id}
                      </Link>
                      <p className="max-w-[34ch] text-xs text-fg-2">{a.role}</p>
                    </Td>
                    <Td>
                      <AgentStatusBadge status={a.status} />
                    </Td>
                    <Td>
                      <Meter used={spent} limit={a.dailyBudget} label={`${a.id} spend today`} />
                    </Td>
                    <Td className="num">
                      {a.allowance ? (
                        <>
                          {usd(a.allowance.remaining)} left
                          <p className="text-xs text-fg-2">of {usd(a.allowance.perPeriod)} / day</p>
                        </>
                      ) : (
                        <span className="text-fg-2">none (sandbox faucet)</span>
                      )}
                    </Td>
                    <Td className="num">{open}</Td>
                    <Td className="text-fg-2">{timeAgo(last, now)}</Td>
                    <Td className="text-right">
                      {a.status === 'killed' ? (
                        <Button
                          disabled={!canAct || busy === a.id}
                          onClick={() => run(a.id, () => actions.revive(a.id), `${a.id} may pay again.`)}
                          title={actHint}
                        >
                          <RotateCcw className="size-3.5" /> Resume
                        </Button>
                      ) : confirm === a.id ? (
                        <span className="inline-flex gap-2">
                          <Button variant="ghost" onClick={() => setConfirm(null)}>
                            Cancel
                          </Button>
                          <Button
                            variant="danger"
                            disabled={busy === a.id}
                            onClick={() =>
                              run(
                                a.id,
                                () => actions.kill(a.id),
                                `Stopped ${a.id}; its channels are closing and unspent escrow returns to the vault.`,
                              )
                            }
                          >
                            {busy === a.id ? 'Stopping…' : 'Confirm stop'}
                          </Button>
                        </span>
                      ) : (
                        <Button
                          variant="danger"
                          disabled={!canAct}
                          title={actHint}
                          onClick={() => setConfirm(a.id)}
                        >
                          <OctagonX className="size-3.5" /> Stop
                        </Button>
                      )}
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  )
}
