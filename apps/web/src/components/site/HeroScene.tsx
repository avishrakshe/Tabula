'use client'

/**
 * The 3D hero: Tabula is a Roman ledger tablet. Three agent orbs stream coral voucher tokens into
 * it; each landing engraves a ledger line. At 4s one agent's stream speeds up and turns red; at
 * 5.6s a crack of light runs across the tablet, the stream is cut mid-flight and its tokens fall
 * into the vault below, followed by the refund. The other two agents keep paying.
 *
 * Deterministic (seeded) so the still frame for reduced motion is always the same picture.
 */
import { Environment, Lightformer, RoundedBox } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Bloom, EffectComposer } from '@react-three/postprocessing'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'

export interface HeroSceneProps {
  /** render loop runs only while the hero is on screen */
  active: boolean
  quality: 'low' | 'high'
  /** reduced motion: one still, lit frame */
  still: boolean
}

const WAX = new THREE.Color('#ff8975')
const SEVER = new THREE.Color('#ff3b2f')
// lit glass orbs below the bloom threshold: only tokens (and the rogue once it runs hot) glow
const ORB = new THREE.Color('#d6d0c8')
const ORB_GLOW = new THREE.Color('#ffe6dc')

const TABLET = { w: 3.6, h: 2.4, d: 0.26, y: 0.45 }
const FACE_Z = TABLET.d / 2 + 0.004
const VAULT_Y = -1.58
const ROGUE_SPEEDUP = 4.0
const KILL_AT = 5.6
const STILL_AT = 5.1
const MAX_TOKENS = 320
const ROWS = 12

interface AgentSpec {
  id: string
  vendor: string
  price: number
  phase: number
  height: number
  interval: number
}

const AGENTS: AgentSpec[] = [
  { id: 'research-01', vendor: 'inference-a', price: 1000, phase: 0.4, height: 1.05, interval: 0.55 },
  { id: 'coder-01', vendor: 'inference-a', price: 1000, phase: 2.5, height: 0.05, interval: 0.48 },
  { id: 'rogue-01', vendor: 'inference-b', price: 1250, phase: 4.4, height: -0.95, interval: 0.6 },
]
const ROGUE = 2

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2)
const usd = (micros: number) => `$${(micros / 1e6).toFixed(5).replace(/0{1,2}$/, '')}`

interface Token {
  on: boolean
  agent: number
  t0: number
  dur: number
  from: THREE.Vector3
  ctrl: THREE.Vector3
  to: THREE.Vector3
  pos: THREE.Vector3
  vel: THREE.Vector3
  falling: boolean
  refund: boolean
  color: THREE.Color
}

interface Row {
  text: string
  born: number
  tone: 'pay' | 'blocked' | 'note'
}

/** Everything that moves, advanced in fixed steps so a still frame is reproducible. */
class Sim {
  time = 0
  rand = mulberry32(7)
  tokens: Token[] = []
  rows: Row[] = []
  spent = AGENTS.map(() => 0)
  next = AGENTS.map((a, i) => 0.25 + i * 0.17 + a.interval * 0.3)
  rogueAlive = true
  killed = false
  refundQueue = 0
  refundNext = 0
  vaultPulse = 0
  crack = 0
  ledgerDirty = true
  total = 0
  seq = 41

  constructor() {
    for (let i = 0; i < MAX_TOKENS; i++) {
      this.tokens.push({
        on: false,
        agent: 0,
        t0: 0,
        dur: 1,
        from: new THREE.Vector3(),
        ctrl: new THREE.Vector3(),
        to: new THREE.Vector3(),
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        falling: false,
        refund: false,
        color: new THREE.Color(),
      })
    }
  }

  orbPos(i: number, t: number, out: THREE.Vector3) {
    const a = AGENTS[i]!
    const ang = a.phase + t * 0.3
    return out.set(
      2.75 * Math.cos(ang),
      a.height + 0.14 * Math.sin(t * 1.3 + i * 2),
      1.2 + 0.85 * Math.sin(ang),
    )
  }

  rogueHot() {
    return this.time >= ROGUE_SPEEDUP && !this.killed
  }

  spawn(agent: number) {
    const tok = this.tokens.find((t) => !t.on)
    if (!tok) return
    const r = this.rand
    tok.on = true
    tok.agent = agent
    tok.falling = false
    tok.refund = false
    tok.t0 = this.time
    const hot = agent === ROGUE && this.rogueHot()
    tok.dur = hot ? 0.75 + r() * 0.2 : 1.15 + r() * 0.35
    this.orbPos(agent, this.time, tok.from)
    // land on the newest ledger line, left of centre, a little spread per agent
    tok.to.set(-1.15 + agent * 0.38 + (r() - 0.5) * 0.5, TABLET.y + TABLET.h / 2 - 0.42, FACE_Z)
    tok.ctrl.copy(tok.from).lerp(tok.to, 0.5)
    tok.ctrl.y += 0.7 + r() * 0.5
    tok.ctrl.z += 0.9
    tok.pos.copy(tok.from)
    tok.color.copy(hot ? SEVER : WAX)
  }

  engrave(text: string, tone: Row['tone']) {
    this.rows.unshift({ text, born: this.time, tone })
    if (this.rows.length > ROWS) this.rows.length = ROWS
    this.ledgerDirty = true
  }

  land(tok: Token) {
    const a = AGENTS[tok.agent]!
    this.spent[tok.agent]! += a.price
    this.total += a.price
    this.seq++
    this.engrave(
      `#${String(this.seq).padStart(4, '0')}  ${a.id.padEnd(11)} → ${a.vendor}  ${usd(a.price).padStart(8)}  Σ ${usd(this.spent[tok.agent]!)}`,
      'pay',
    )
  }

  kill() {
    this.killed = true
    this.rogueAlive = false
    const r = this.rand
    for (const t of this.tokens) {
      if (!t.on || t.agent !== ROGUE || t.falling) continue
      t.falling = true
      t.vel.set((r() - 0.5) * 0.6, 0.4 + r() * 0.6, (r() - 0.5) * 0.4)
    }
    this.engrave(`BLOCKED  rogue-01 → inference-b  ${usd(AGENTS[ROGUE]!.price)}  velocity limit`, 'blocked')
    this.refundQueue = 26
    this.refundNext = this.time + 0.55
  }

  refund() {
    const tok = this.tokens.find((t) => !t.on)
    if (!tok) return
    const r = this.rand
    tok.on = true
    tok.agent = ROGUE
    tok.refund = true
    tok.falling = true
    tok.t0 = this.time
    this.orbPos(ROGUE, this.time, tok.pos)
    tok.vel.set((r() - 0.5) * 1.2, 0.3 + r() * 0.8, (r() - 0.5) * 0.6)
    tok.color.copy(WAX)
  }

  step(dt: number) {
    this.time += dt
    const t = this.time
    for (let i = 0; i < AGENTS.length; i++) {
      if (i === ROGUE && !this.rogueAlive) continue
      const interval = i === ROGUE && this.rogueHot() ? 0.075 : AGENTS[i]!.interval
      if (t >= this.next[i]!) {
        this.spawn(i)
        this.next[i] = t + interval * (0.85 + this.rand() * 0.3)
      }
    }
    if (!this.killed && t >= KILL_AT) this.kill()
    if (this.killed) {
      this.crack = Math.min(1, this.crack + dt / 0.45)
      if (this.refundQueue > 0 && t >= this.refundNext) {
        this.refund()
        this.refundQueue--
        this.refundNext = t + 0.035
        if (this.refundQueue === 0)
          this.engrave('rogue-01 stopped · channel closed · refund swept to the vault', 'note')
      }
    }
    this.vaultPulse = Math.max(0, this.vaultPulse - dt * 1.6)

    for (const tok of this.tokens) {
      if (!tok.on) continue
      if (tok.falling) {
        tok.vel.y -= 5.2 * dt
        // drift toward the vault's slot as it falls
        tok.vel.x += (0 - tok.pos.x) * 1.4 * dt
        tok.vel.z += (0.55 - tok.pos.z) * 1.4 * dt
        tok.pos.addScaledVector(tok.vel, dt)
        if (tok.pos.y <= VAULT_Y + 0.2) {
          tok.on = false
          this.vaultPulse = Math.min(1, this.vaultPulse + 0.18)
        }
        continue
      }
      const u = Math.min(1, (t - tok.t0) / tok.dur)
      const e = ease(u)
      const k = 1 - e
      tok.pos
        .copy(tok.from)
        .multiplyScalar(k * k)
        .addScaledVector(tok.ctrl, 2 * k * e)
        .addScaledVector(tok.to, e * e)
      if (u >= 1) {
        tok.on = false
        this.land(tok)
      }
    }
  }
}

/** Polished dark stone with an engraved border, drawn once and reused under every ledger redraw. */
function stoneFace(W: number, H: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const light = g.createRadialGradient(W * 0.38, H * 0.25, 40, W * 0.5, H * 0.5, W * 0.75)
  light.addColorStop(0, 'rgba(255,236,228,0.07)')
  light.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = light
  g.fillRect(0, 0, W, H)
  const rand = mulberry32(3)
  for (let i = 0; i < 2600; i++) {
    const a = rand() * 0.06
    g.fillStyle = rand() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 2})`
    g.fillRect(rand() * W, rand() * H, 1 + rand() * 1.5, 1 + rand() * 1.5)
  }
  // engraved border: a dark groove with a lit lower lip
  g.strokeStyle = 'rgba(0,0,0,0.6)'
  g.lineWidth = 3
  g.strokeRect(24, 24, W - 48, H - 48)
  g.strokeStyle = 'rgba(255,220,210,0.12)'
  g.lineWidth = 1.5
  g.strokeRect(26, 26, W - 50, H - 50)
  return c
}

let stone: HTMLCanvasElement | null = null

function drawLedger(ctx: CanvasRenderingContext2D, sim: Sim) {
  const { width: W, height: H } = ctx.canvas
  ctx.clearRect(0, 0, W, H)
  stone ??= stoneFace(W, H)
  ctx.drawImage(stone, 0, 0)
  ctx.textBaseline = 'middle'
  ctx.font = '600 19px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  ctx.fillStyle = 'rgba(172,175,185,0.75)'
  ctx.fillText('L E D G E R', 54, 56)
  const total = `Σ ${usd(sim.total)}`
  ctx.fillText(total, W - 54 - ctx.measureText(total).width, 56)
  ctx.fillStyle = 'rgba(255,255,255,0.08)'
  ctx.fillRect(54, 84, W - 108, 2)

  ctx.font = '500 21px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  sim.rows.forEach((row, i) => {
    const y = 120 + i * 44
    const age = sim.time - row.born
    const fresh = Math.max(0, 1 - age / 1.1)
    const fade = Math.max(0.18, 1 - i * 0.075)
    // engraved: a dark lip under a lit stroke
    ctx.fillStyle = `rgba(0,0,0,${0.55 * fade})`
    ctx.fillText(row.text, 55, y + 2)
    if (row.tone === 'blocked') ctx.fillStyle = `rgba(255,90,74,${Math.max(0.85, fade)})`
    else if (row.tone === 'note') ctx.fillStyle = `rgba(255,170,150,${fade})`
    else {
      const r = Math.round(232 + 23 * fresh)
      const g = Math.round(228 - 91 * fresh)
      const b = Math.round(222 - 105 * fresh)
      ctx.fillStyle = `rgba(${r},${g},${b},${fade * (0.62 + 0.38 * fresh)})`
    }
    ctx.fillText(row.text, 54, y)
  })
}

function crackPoints(): THREE.Vector3[] {
  const r = mulberry32(42)
  const pts: THREE.Vector3[] = []
  const n = 16
  for (let i = 0; i <= n; i++) {
    const u = i / n
    const x = -TABLET.w / 2 + 0.06 + u * (TABLET.w - 0.12)
    const y = TABLET.y + 0.32 - u * 0.55 + (i === 0 || i === n ? 0 : (r() - 0.5) * 0.22)
    pts.push(new THREE.Vector3(x, y, FACE_Z + 0.004))
  }
  return pts
}

function ResponsiveCamera() {
  const { camera, size } = useThree()
  useEffect(() => {
    const aspect = size.width / Math.max(1, size.height)
    const z = aspect < 1.9 ? Math.min(14, 7 * (1.9 / aspect)) : 7
    camera.position.set(0, 0.15, z)
    camera.lookAt(0, -0.1, 0)
    camera.updateProjectionMatrix()
  }, [camera, size])
  return null
}

function World({ still }: { still: boolean }) {
  const sim = useMemo(() => {
    const s = new Sim()
    if (still) while (s.time < STILL_AT) s.step(1 / 60)
    return s
  }, [still])

  const canvas = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = 1024
    c.height = 683
    return c
  }, [])
  const texture = useMemo(() => {
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    return tex
  }, [canvas])
  const ctx = useMemo(() => canvas.getContext('2d')!, [canvas])

  const tokens = useRef<THREE.InstancedMesh>(null)
  const orbs = useRef<(THREE.Mesh | null)[]>([])
  const tablet = useRef<THREE.Group>(null)
  const crack = useRef<THREE.InstancedMesh>(null)
  const crackMat = useRef<THREE.MeshBasicMaterial>(null)
  const slot = useRef<THREE.MeshBasicMaterial>(null)
  const rogueLight = useRef<THREE.PointLight>(null)
  const lastDraw = useRef(-1)
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const hdr = useMemo(() => new THREE.Color(), [])
  const segments = useMemo(() => {
    const pts = crackPoints()
    return pts.slice(1).map((b, i) => {
      const a = pts[i]!
      return {
        mid: a.clone().add(b).multiplyScalar(0.5),
        len: a.distanceTo(b) + 0.012,
        angle: Math.atan2(b.y - a.y, b.x - a.x),
      }
    })
  }, [])

  useEffect(() => () => texture.dispose(), [texture])

  // lay the crack's segments once; the frame loop only reveals them
  useEffect(() => {
    const mesh = crack.current
    if (!mesh) return
    segments.forEach((s, i) => {
      dummy.position.copy(s.mid)
      dummy.rotation.set(0, 0, s.angle)
      dummy.scale.set(s.len, 1, 1)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.count = 0
  }, [segments, dummy])

  useFrame((_state, delta) => {
    if (!still) {
      // fixed sub-steps keep the motion identical at any frame rate
      let left = Math.min(delta, 1 / 15)
      while (left > 1e-6) {
        const dt = Math.min(left, 1 / 60)
        sim.step(dt)
        left -= dt
      }
    }
    const t = sim.time

    if (tablet.current) {
      tablet.current.rotation.y = Math.sin(t * 0.35) * 0.09
      tablet.current.rotation.x = -0.1 + Math.sin(t * 0.27) * 0.025
      tablet.current.position.y = Math.sin(t * 0.6) * 0.05
    }

    // ledger texture: redraw when a line lands, and while the newest line cools from coral
    const hot = sim.rows[0] && t - sim.rows[0].born < 1.2
    if (sim.ledgerDirty || (hot && t - lastDraw.current > 0.05)) {
      drawLedger(ctx, sim)
      texture.needsUpdate = true
      sim.ledgerDirty = false
      lastDraw.current = t
    }

    for (let i = 0; i < AGENTS.length; i++) {
      const orb = orbs.current[i]
      if (!orb) continue
      sim.orbPos(i, t, orb.position)
      const mat = orb.material as THREE.MeshPhysicalMaterial
      if (i === ROGUE) {
        const heat = sim.killed ? 0 : Math.min(1, Math.max(0, (t - ROGUE_SPEEDUP) / 0.6))
        if (sim.killed) {
          mat.color.setRGB(0.2, 0.2, 0.22)
          mat.emissiveIntensity = 0
        } else {
          mat.color.copy(ORB).lerp(SEVER, heat * 0.6)
          mat.emissive.copy(ORB_GLOW).lerp(SEVER, heat)
          // the rogue's core runs hot enough to bloom
          mat.emissiveIntensity = 0.3 + heat * 3.2
        }
        if (rogueLight.current) {
          rogueLight.current.position.copy(orb.position)
          rogueLight.current.intensity = sim.killed ? 0 : heat * 6
        }
      }
    }

    const mesh = tokens.current
    if (mesh) {
      let n = 0
      for (const tok of sim.tokens) {
        if (!tok.on) continue
        const age = t - tok.t0
        const s = tok.falling
          ? 0.75
          : Math.min(1, age * 6) * (0.55 + 0.45 * Math.sin(Math.min(1, age / tok.dur) * Math.PI))
        dummy.position.copy(tok.pos)
        dummy.rotation.set(age * 3 + tok.t0, age * 2, 0)
        dummy.scale.setScalar(Math.max(0.001, s))
        dummy.updateMatrix()
        mesh.setMatrixAt(n, dummy.matrix)
        // HDR colour so only the tokens cross the bloom threshold
        mesh.setColorAt(n, hdr.copy(tok.color).multiplyScalar(tok.refund ? 2.2 : 2.8))
        n++
      }
      mesh.count = n
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }

    // the crack runs left to right, flares, then cools to a faint scar
    if (crack.current && crackMat.current) {
      crack.current.count = Math.round(sim.crack * segments.length)
      const since = sim.killed ? t - KILL_AT : 0
      const glow = 0.45 + 3.2 * Math.max(0, 1 - since / 2.2)
      crackMat.current.color.setRGB(glow, glow * 0.66, glow * 0.56)
    }

    if (slot.current) slot.current.color.copy(WAX).multiplyScalar(0.35 + sim.vaultPulse * 2.4)
  })

  return (
    <>
      <ResponsiveCamera />
      <ambientLight intensity={0.25} />
      <directionalLight position={[3, 4, 6]} intensity={1.1} color="#fff4ec" />
      <pointLight ref={rogueLight} color="#ff3b2f" intensity={0} distance={6} decay={1.6} />

      <group ref={tablet}>
        <RoundedBox
          args={[TABLET.w, TABLET.h, TABLET.d]}
          radius={0.07}
          smoothness={4}
          position={[0, TABLET.y, 0]}
        >
          <meshPhysicalMaterial
            color="#17171a"
            roughness={0.42}
            metalness={0.25}
            clearcoat={1}
            clearcoatRoughness={0.18}
            envMapIntensity={0.9}
          />
        </RoundedBox>
        <mesh position={[0, TABLET.y, FACE_Z]}>
          <planeGeometry args={[TABLET.w - 0.16, (TABLET.w - 0.16) * (683 / 1024)]} />
          <meshBasicMaterial map={texture} transparent toneMapped={false} />
        </mesh>
        <instancedMesh ref={crack} args={[undefined, undefined, segments.length]} frustumCulled={false}>
          <boxGeometry args={[1, 0.02, 0.006]} />
          <meshBasicMaterial ref={crackMat} toneMapped={false} />
        </instancedMesh>
      </group>

      {AGENTS.map((a, i) => (
        <mesh
          key={a.id}
          ref={(m) => {
            orbs.current[i] = m
          }}
        >
          <sphereGeometry args={[0.13, 32, 32]} />
          <meshPhysicalMaterial
            color={ORB}
            emissive={ORB_GLOW}
            emissiveIntensity={0.3}
            roughness={0.18}
            clearcoat={1}
            toneMapped={false}
          />
        </mesh>
      ))}

      <instancedMesh ref={tokens} args={[undefined, undefined, MAX_TOKENS]} frustumCulled={false}>
        <boxGeometry args={[0.075, 0.075, 0.075]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      <group position={[0, VAULT_Y, 0.55]}>
        <RoundedBox args={[2.1, 0.32, 1.0]} radius={0.06} smoothness={3}>
          <meshPhysicalMaterial color="#121214" roughness={0.5} metalness={0.3} clearcoat={0.6} />
        </RoundedBox>
        <mesh position={[0, 0.161, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[1.3, 0.08]} />
          <meshBasicMaterial ref={slot} toneMapped={false} />
        </mesh>
      </group>
    </>
  )
}

export default function HeroScene({ active, quality, still }: HeroSceneProps) {
  const high = quality === 'high'
  return (
    <Canvas
      frameloop={still ? 'demand' : active ? 'always' : 'never'}
      dpr={high ? [1, 1.75] : 1}
      gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
      camera={{ position: [0, 0.15, 7], fov: 34 }}
    >
      <World still={still} />
      <Environment resolution={64} frames={1}>
        <Lightformer form="rect" intensity={2.2} color="#ffd8cf" position={[0, 3, 4]} scale={[6, 1.2, 1]} />
        <Lightformer form="rect" intensity={3} color="#ff8975" position={[-5, 0.5, -2]} scale={[2, 4, 1]} />
        <Lightformer form="ring" intensity={1.2} color="#ffffff" position={[4, -1, 3]} scale={2} />
      </Environment>
      {high ? (
        <EffectComposer multisampling={0}>
          <Bloom mipmapBlur intensity={0.75} luminanceThreshold={1} luminanceSmoothing={0.1} radius={0.45} />
        </EffectComposer>
      ) : null}
    </Canvas>
  )
}
