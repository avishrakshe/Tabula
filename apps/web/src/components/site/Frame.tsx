import Image, { type StaticImageData } from 'next/image'

/** A real dashboard screenshot in a rounded product frame; `fade` softens a crop that ends mid-row. */
export function Frame({
  src,
  alt,
  caption,
  fade = false,
  preload = false,
  sizes = '(min-width: 1200px) 1150px, 100vw',
  className = '',
}: {
  src: StaticImageData
  alt: string
  caption?: string
  fade?: boolean
  preload?: boolean
  sizes?: string
  className?: string
}) {
  return (
    <figure className={className}>
      <div className="relative overflow-hidden rounded-[22px] border border-white/10 bg-night p-1.5 shadow-[0_40px_120px_-48px_rgba(255,137,117,0.35)]">
        <Image
          src={src}
          alt={alt}
          sizes={sizes}
          placeholder="blur"
          preload={preload}
          className="h-auto w-full rounded-[16px]"
        />
        {fade ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-1.5 bottom-1.5 h-28 rounded-b-[16px] bg-linear-to-t from-night to-transparent"
          />
        ) : null}
      </div>
      {caption ? <figcaption className="mt-3 text-sm text-gray-1">{caption}</figcaption> : null}
    </figure>
  )
}
