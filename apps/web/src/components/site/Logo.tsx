/**
 * The Tabula mark: the T's bar, three ledger rows for its stem, and the coral dot (the one voucher that
 * was stopped). Geometry measured from the 1024px app icon; the mark alone is its 546×636 content box.
 */
export const MARK_VIEWBOX = '239 196 546 636'

export function MarkShapes({
  ink = 'currentColor',
  dot = 'var(--color-wax)',
}: {
  ink?: string
  dot?: string
}) {
  return (
    <>
      <rect x={239} y={196.5} width={546} height={110} rx={55} fill={ink} />
      <rect x={457} y={358.5} width={110} height={77} rx={32} fill={ink} />
      <rect x={457} y={469.5} width={110} height={77} rx={32} fill={ink} />
      <rect x={457} y={580.5} width={110} height={77} rx={32} fill={ink} />
      <circle cx={512} cy={776.5} r={55.5} fill={dot} />
    </>
  )
}

/** The mark on its own, sized by `className` (height drives it; the width follows the aspect ratio). */
export function LogoMark({ className = 'h-6 w-auto', title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <MarkShapes />
    </svg>
  )
}

/** Mark plus the name, for the nav, the footer and the dashboard sidebar. */
export function Wordmark({
  className = '',
  markClassName = 'h-[22px] w-auto',
}: {
  className?: string
  markClassName?: string
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark className={markClassName} />
      <span className="font-semibold tracking-tight">Tabula</span>
    </span>
  )
}
