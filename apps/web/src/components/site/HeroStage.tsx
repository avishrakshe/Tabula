'use client'

import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react'
import { useRef } from 'react'
import overviewShot from '../../../public/shots/overview.jpg'
import { Frame } from './Frame'
import { HeroCanvas } from './HeroCanvas'

/** The 3D tablet, easing into a framed screenshot of the dashboard as the page scrolls. */
export function HeroStage({ caption }: { caption: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 0.35', 'end start'] })
  const sceneOpacity = useTransform(scrollYProgress, [0, 0.4], [1, 0.15])
  const sceneY = useTransform(scrollYProgress, [0, 0.4], [0, 80])
  const frameScale = useTransform(scrollYProgress, [0, 0.3], [0.93, 1])
  const frameY = useTransform(scrollYProgress, [0, 0.3], [40, 0])

  return (
    <div ref={ref} className="relative mx-auto mt-4 max-w-[1200px] px-4 pb-24 md:px-6 md:pb-32">
      <motion.div style={reduce ? undefined : { opacity: sceneOpacity, y: sceneY }}>
        <HeroCanvas className="h-[360px] md:h-[540px]" />
      </motion.div>
      <motion.div
        style={reduce ? undefined : { scale: frameScale, y: frameY }}
        className="relative -mt-6 origin-top md:-mt-10"
      >
        <Frame
          src={overviewShot}
          alt="The Tabula dashboard overview mid-run: spend by agent, one agent stopped, three open channels"
          caption={caption}
        />
      </motion.div>
    </div>
  )
}
