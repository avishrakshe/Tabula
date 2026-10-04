'use client'

import { Check, CircleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th } from '@/components/ui'
import { useTabula } from '@/lib/data/provider'
import { timeAgo } from '@/lib/format'
import type { PolicyRow } from '@/lib/types'

function scopeLabel(p: Pick<PolicyRow, 'scope' | 'scopeId'>) {
  return p.scope === 'global' ? 'Global' : `${p.scope === 'agent' ? 'Agent' : 'Vendor'} · ${p.scopeId}`
}

export default function PoliciesPage() {
  const { data, actions, canAct, actHint, now } = useTabula()
  // a stable order (global, then agents and vendors by name) so a save doesn't reshuffle the list
  const active = useMemo(
    () =>
      data.policies
        .filter((p) => p.active)
        .sort((a, b) =>
          (a.scope === 'global' ? '' : `${a.scope}:${a.scopeId}`).localeCompare(
            b.scope === 'global' ? '' : `${b.scope}:${b.scopeId}`,
          ),
        ),
    [data.policies],
  )
  const [selected, setSelected] = useState<string>('global')
  const current =
    active.find((p) => (p.scope === 'global' ? 'global' : `${p.scope}:${p.scopeId}`) === selected) ??
    active[0]
  const [draft, setDraft] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // reset the editor when the saved rules change (not on every data refresh); scope clicks reset it too
  const savedRules = JSON.stringify(current?.rules ?? {}, null, 2)
  useEffect(() => setDraft(savedRules), [savedRules])

  const history = data.policies.filter(
    (p) => current && p.scope === current.scope && p.scopeId === current.scopeId,
  )

  return (
    <>
      <PageHeader
        title="Policies"
        description="Rules every voucher is checked against before it is signed. Scopes combine: the strictest limit wins. Every change is versioned and written to the audit log."
      />
      {active.length === 0 ? (
        <Card>
          <EmptyState title="No policies yet">Run pnpm setup to install the demo policies.</EmptyState>
        </Card>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[280px_1fr]">
          <Card>
            <CardHeader title="Scopes" />
            <ul className="p-2">
              {active.map((p) => {
                const key = p.scope === 'global' ? 'global' : `${p.scope}:${p.scopeId}`
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(key)
                        setDraft(JSON.stringify(p.rules ?? {}, null, 2))
                        setMsg(null)
                      }}
                      className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm ${current?.id === p.id ? 'bg-surface-2 font-medium' : 'hover:bg-surface-2'}`}
                    >
                      {scopeLabel(p)}
                      <Badge>v{p.version}</Badge>
                    </button>
                  </li>
                )
              })}
            </ul>
          </Card>
          <div className="space-y-6">
            <Card>
              <CardHeader
                title={current ? scopeLabel(current) : 'Policy'}
                subtitle={
                  current
                    ? `Version ${current.version} by ${current.updatedBy}, ${timeAgo(current.updatedAt, now)}`
                    : undefined
                }
                actions={
                  <Button
                    variant="primary"
                    disabled={!canAct || !current}
                    title={actHint}
                    onClick={async () => {
                      if (!current) return
                      setMsg(null)
                      let rules: Record<string, unknown>
                      try {
                        rules = JSON.parse(draft) as Record<string, unknown>
                      } catch (err) {
                        setMsg({
                          ok: false,
                          text: `Not saved: that isn't valid JSON (${(err as Error).message}).`,
                        })
                        return
                      }
                      try {
                        const v = await actions.savePolicy(current.scope, current.scopeId, rules)
                        setMsg({ ok: true, text: `Saved version ${v}.` })
                      } catch (err) {
                        setMsg({ ok: false, text: `Not saved: ${(err as Error).message}` })
                      }
                    }}
                  >
                    Save new version
                  </Button>
                }
              />
              <div className="p-5">
                <label htmlFor="rules" className="sr-only">
                  Rules JSON
                </label>
                <textarea
                  id="rules"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  rows={16}
                  className="w-full rounded-xl border border-line bg-bg p-3 font-mono text-[13px]"
                />
                {msg?.ok ? (
                  <p role="status" className="mt-2 flex items-center gap-1.5 text-sm text-fg-2">
                    <Check className="size-4" aria-hidden /> {msg.text}
                  </p>
                ) : msg ? (
                  <p role="alert" className="mt-2 flex items-center gap-1.5 text-sm text-sever">
                    <CircleAlert className="size-4 shrink-0" aria-hidden /> {msg.text}
                  </p>
                ) : null}
                <p className="mt-3 text-xs text-fg-2">
                  Fields: dailyBudgetUsd, perTaskBudgetUsd, velocity {'{windowSec, maxUsd}'} (or a list),
                  maxUnitPriceUsd, vendors {'{allow, deny}'}, anomaly {'{zScore, minSamples, bucketSec}'},
                  onViolation (block | pause | kill_and_close).
                </p>
              </div>
            </Card>
            <Card>
              <CardHeader title="History" />
              <Table>
                <thead>
                  <tr>
                    <Th>Version</Th>
                    <Th>Updated by</Th>
                    <Th>When</Th>
                    <Th>Rules</Th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((p) => (
                    <tr key={p.id}>
                      <Td className="num">
                        v{p.version} {p.active ? <Badge tone="live">active</Badge> : null}
                      </Td>
                      <Td>{p.updatedBy}</Td>
                      <Td className="text-fg-2">{timeAgo(p.updatedAt, now)}</Td>
                      <Td className="max-w-[60ch] truncate font-mono text-xs text-fg-2">
                        {JSON.stringify(p.rules)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          </div>
        </div>
      )}
    </>
  )
}
