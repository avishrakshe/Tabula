import type { Metadata } from 'next'
import { HeroCanvas } from '@/components/site/HeroCanvas'

export const metadata: Metadata = {
  title: 'Tabula hero',
  description: 'The Tabula 3D hero on a transparent background, for embedding (no navigation).',
  robots: { index: false },
}

/** The hero scene alone, transparent, for embedding in an iframe or a Framer code component. */
export default function HeroEmbed() {
  return (
    <>
      <style>{'html, body { background: transparent !important; }'}</style>
      <HeroCanvas className="h-dvh w-full" />
    </>
  )
}
