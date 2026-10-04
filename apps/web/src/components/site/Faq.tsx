'use client'

import { Plus } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { type ReactNode, useId, useState } from 'react'

export function Faq({ items }: { items: { q: string; a: ReactNode }[] }) {
  const [open, setOpen] = useState<number | null>(0)
  const reduce = useReducedMotion()
  const id = useId()
  return (
    <ul className="divide-y divide-white/10 border-y border-white/10">
      {items.map((item, i) => {
        const isOpen = open === i
        return (
          <li key={item.q}>
            <h3>
              <button
                type="button"
                id={`${id}-q${i}`}
                aria-expanded={isOpen}
                aria-controls={`${id}-a${i}`}
                onClick={() => setOpen(isOpen ? null : i)}
                className="flex w-full items-center justify-between gap-6 py-6 text-left text-h5 font-medium text-paper"
              >
                {item.q}
                <Plus
                  aria-hidden
                  className={`size-5 shrink-0 text-gray-1 transition-transform duration-300 ${isOpen ? 'rotate-45' : ''}`}
                />
              </button>
            </h3>
            <AnimatePresence initial={false}>
              {isOpen ? (
                <motion.div
                  id={`${id}-a${i}`}
                  role="region"
                  aria-labelledby={`${id}-q${i}`}
                  initial={reduce ? false : { height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <div className="max-w-[65ch] pb-6 text-body-lg text-gray-1">{item.a}</div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </li>
        )
      })}
    </ul>
  )
}
