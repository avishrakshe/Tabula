'use client'

import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { cx } from '@/components/ui'

export interface Series {
  id: string
  label: string
  /** CSS color, e.g. var(--tb-series-1). Marks only; text never wears it. */
  color: string
  points: { x: number; y: number }[]
}

export interface ReferenceLine {
  y: number
  label: string
}

interface Props {
  series: Series[]
  height?: number
  yFormat: (v: number) => string
  xFormat: (v: number) => string
  reference?: ReferenceLine
  /** Area wash under a single series. */
  area?: boolean
  emptyText?: ReactNode
  ariaLabel: string
}

const PAD = { top: 16, right: 16, bottom: 28, left: 64 }

function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const ticks: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toPrecision(12)))
  if (ticks[ticks.length - 1]! < max) ticks.push(Number((ticks[ticks.length - 1]! + step).toPrecision(12)))
  return ticks
}

/**
 * Multi-series line chart: 2px lines, hairline grid, crosshair + tooltip listing every series at
 * the nearest x, legend for >= 2 series, end dots with a surface ring, table view toggle.
 */
export function LineChart({
  series,
  height = 240,
  yFormat,
  xFormat,
  reference,
  area,
  emptyText,
  ariaLabel,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [hoverX, setHoverX] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)
  const gradId = useId()

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry!.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const all = series.flatMap((s) => s.points)
  const xs = useMemo(
    () => [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b),
    [series],
  )
  const empty = all.length < 2

  const xMin = empty ? 0 : Math.min(...all.map((p) => p.x))
  const xMax = empty ? 1 : Math.max(...all.map((p) => p.x))
  const yMaxData = Math.max(0, ...all.map((p) => p.y), reference?.y ?? 0)
  const yTicks = niceTicks(yMaxData * 1.08)
  const yMax = yTicks[yTicks.length - 1]! || 1
  const innerW = width - PAD.left - PAD.right
  const innerH = height - PAD.top - PAD.bottom
  const sx = (x: number) => PAD.left + (xMax === xMin ? 0 : ((x - xMin) / (xMax - xMin)) * innerW)
  const sy = (y: number) => PAD.top + innerH - (y / yMax) * innerH
  const xTicks = useMemo(() => {
    const n = Math.max(2, Math.min(6, Math.floor(innerW / 110)))
    return Array.from({ length: n }, (_, i) => xMin + ((xMax - xMin) * i) / (n - 1))
  }, [innerW, xMin, xMax])

  const valueAt = (s: Series, x: number): number | null => {
    let best: { x: number; y: number } | null = null
    for (const p of s.points) if (p.x <= x && (!best || p.x > best.x)) best = p
    return best ? best.y : null
  }

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left + PAD.left
    const target = xMin + ((px - PAD.left) / innerW) * (xMax - xMin)
    let nearest = xs[0] ?? null
    for (const x of xs) if (Math.abs(x - target) < Math.abs((nearest ?? x) - target)) nearest = x
    setHoverX(nearest)
  }

  const path = (s: Series) =>
    s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ')

  return (
    <div ref={wrap} className="relative w-full">
      {series.length >= 2 ? (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-2" aria-label="Legend">
          {series.map((s) => (
            <li key={s.id} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-0.5 w-3.5 rounded-full"
                style={{ background: s.color }}
                aria-hidden
              />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      {empty ? (
        <div
          className="flex items-center justify-center rounded-xl border border-dashed border-line text-sm text-fg-2"
          style={{ height }}
        >
          {emptyText ?? 'No data yet'}
        </div>
      ) : showTable ? (
        <div className="max-h-[320px] overflow-auto rounded-xl border border-line">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface">
              <tr>
                <th className="px-3 py-2 font-medium text-fg-2">Time</th>
                {series.map((s) => (
                  <th key={s.id} className="px-3 py-2 font-medium text-fg-2">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {xs.map((x) => (
                <tr key={x} className="border-t border-line/60">
                  <td className="num px-3 py-1.5">{xFormat(x)}</td>
                  {series.map((s) => {
                    const v = valueAt(s, x)
                    return (
                      <td key={s.id} className="num px-3 py-1.5">
                        {v === null ? '—' : yFormat(v)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          className="block overflow-visible"
        >
          <defs>
            <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={series[0]?.color} stopOpacity="0.14" />
              <stop offset="100%" stopColor={series[0]?.color} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {yTicks.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={sy(v)}
                y2={sy(v)}
                stroke="var(--tb-grid)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={sy(v)}
                dy="0.32em"
                textAnchor="end"
                className="num fill-muted text-[11px]"
              >
                {yFormat(v)}
              </text>
            </g>
          ))}
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={sy(0)}
            y2={sy(0)}
            stroke="var(--tb-line)"
            strokeWidth={1}
          />
          {xTicks.map((x, i) => (
            <text
              key={x}
              x={sx(x)}
              y={height - 8}
              textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
              className="num fill-muted text-[11px]"
            >
              {xFormat(x)}
            </text>
          ))}
          {reference ? (
            <g>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={sy(reference.y)}
                y2={sy(reference.y)}
                stroke="var(--tb-fg-2)"
                strokeWidth={1}
                strokeOpacity={0.55}
              />
              <text
                x={width - PAD.right}
                y={sy(reference.y) - 6}
                textAnchor="end"
                className="fill-fg-2 text-[11px]"
              >
                {reference.label}
              </text>
            </g>
          ) : null}
          {area && series.length === 1 && series[0]!.points.length > 1 ? (
            <path
              d={`${path(series[0]!)} L${sx(series[0]!.points.at(-1)!.x)},${sy(0)} L${sx(series[0]!.points[0]!.x)},${sy(0)} Z`}
              fill={`url(#${gradId})`}
            />
          ) : null}
          {series.map((s) => (
            <path
              key={s.id}
              d={path(s)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {series.map((s) => {
            const last = s.points.at(-1)
            if (!last) return null
            return (
              <circle
                key={s.id}
                cx={sx(last.x)}
                cy={sy(last.y)}
                r={4}
                fill={s.color}
                stroke="var(--tb-surface)"
                strokeWidth={2}
              />
            )
          })}
          {hoverX !== null ? (
            <g pointerEvents="none">
              <line
                x1={sx(hoverX)}
                x2={sx(hoverX)}
                y1={PAD.top}
                y2={PAD.top + innerH}
                stroke="var(--tb-fg-2)"
                strokeWidth={1}
                strokeOpacity={0.5}
              />
              {series.map((s) => {
                const v = valueAt(s, hoverX)
                return v === null ? null : (
                  <circle
                    key={s.id}
                    cx={sx(hoverX)}
                    cy={sy(v)}
                    r={4}
                    fill={s.color}
                    stroke="var(--tb-surface)"
                    strokeWidth={2}
                  />
                )
              })}
            </g>
          ) : null}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={innerW}
            height={innerH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHoverX(null)}
          />
        </svg>
      )}
      {hoverX !== null && !showTable && !empty ? (
        <div
          className="pointer-events-none absolute z-10 min-w-40 rounded-xl border border-line bg-surface px-3 py-2 text-xs shadow-lg"
          style={{
            left: Math.min(width - 180, Math.max(0, sx(hoverX) + 12)),
            top: series.length >= 2 ? 36 : 8,
          }}
        >
          <p className="num mb-1 text-muted">{xFormat(hoverX)}</p>
          {series.map((s) => {
            const v = valueAt(s, hoverX)
            return (
              <p key={s.id} className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 text-fg-2">
                  <span
                    className="inline-block h-0.5 w-3 rounded-full"
                    style={{ background: s.color }}
                    aria-hidden
                  />
                  {s.label}
                </span>
                <span className="num font-medium text-fg">{v === null ? '—' : yFormat(v)}</span>
              </p>
            )
          })}
        </div>
      ) : null}
      {!empty ? (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => setShowTable((v) => !v)}
            className={cx('text-xs text-fg-2 underline-offset-4 hover:underline')}
          >
            {showTable ? 'Show chart' : 'Show as table'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
