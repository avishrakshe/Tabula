import type { Metadata } from 'next'
import { FilmRender } from '@/components/film/FilmRender'
import { filmFacts } from '@/lib/film-facts'

// the bare stage for scripts/render-film.ts; not a page for people
export const metadata: Metadata = { title: 'Tabula film (render)', robots: { index: false, follow: false } }

export default function FilmRenderPage() {
  return <FilmRender facts={filmFacts()} />
}
