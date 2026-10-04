/**
 * Campus-wide conditions, drawn over the whole view and under the storms.
 * Each one gathers at the edges of the screen and keeps the middle readable:
 * heat glows in from the edges with rising shimmer, cold frosts the borders,
 * and wind streams across from the south-west. `progress` drives the arrival;
 * `intensity` settles to a faint level that still reads at a glance.
 */
import type { HazardKind } from '../../../lib/weather/types'
import {
  TAU,
  clamp01,
  easeOut,
  edgeBand,
  edgeWeight,
  frameScale,
  hash3,
  inset,
  lerp,
  memo,
  rgba,
  smooth,
  vignette,
  wrap,
} from './c-shared'
import type { CampusArgs, CampusRenderer, Frame } from './types'
import { rng } from './util'

// ---------------------------------------------------------------------------
// Heat: amber vignette, sun glare in the top corner, shimmer rising off the ground.
// ---------------------------------------------------------------------------

interface Wisp {
  speed: number
  len: number
  amp: number
  freq: number
  phase: number
  width: number
  /** Seconds of rise before it fades and starts again somewhere else. */
  life: number
  offset: number
}

const WISPS = 54

function wisps(seed: number): Wisp[] {
  return memo(`heat:${seed}`, () => {
    const r = rng(seed ^ 0x6a09e667)
    return Array.from({ length: WISPS }, () => ({
      speed: 16 + r() * 26,
      len: 46 + r() * 84,
      amp: 1.6 + r() * 3.4,
      freq: 0.11 + r() * 0.08,
      phase: r() * TAU,
      width: 1.3 + r() * 1.3,
      life: 3.2 + r() * 3.4,
      offset: r() * 10,
    }))
  })
}

/** Spawn points lean toward the side edges and the bottom, where the heat gathers. */
function wispSpawn(i: number, cycle: number, w: number, h: number): { x: number; y: number } {
  const u = hash3(i, cycle, 11)
  const v = hash3(i, cycle, 23)
  const side = u < 0.5 ? Math.pow(u * 2, 1.7) * 0.5 : 1 - Math.pow((1 - u) * 2, 1.7) * 0.5
  return { x: side * w, y: h * (0.18 + 0.92 * Math.pow(v, 0.65)) }
}

/** One radial pass whose colour warms from amber to deep orange toward the edges. */
function heatVignette(ctx: CanvasRenderingContext2D, w: number, h: number, dark: boolean, k: number, inner: number): void {
  const i = Math.max(0, Math.min(0.97, inner))
  const amber = dark ? '251,191,36' : '245,158,11'
  const orange = '249,115,22'
  const rim = '234,88,12'
  ctx.save()
  ctx.translate(w / 2, h / 2)
  ctx.scale(w / 2, h / 2)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1.25)
  g.addColorStop(0, rgba(amber, 0))
  g.addColorStop(i, rgba(amber, 0))
  g.addColorStop(lerp(i, 1, 0.45), rgba(amber, (dark ? 0.1 : 0.13) * k))
  g.addColorStop(lerp(i, 1, 0.78), rgba(orange, (dark ? 0.3 : 0.26) * k))
  g.addColorStop(1, rgba(rim, (dark ? 0.52 : 0.42) * k))
  ctx.fillStyle = g
  ctx.fillRect(-1, -1, 2, 2)
  ctx.restore()
}

const heat: CampusRenderer = {
  draw(f, a) {
    const { ctx, width: w, height: h, dark } = f
    const k = clamp01(a.intensity)
    if (k <= 0.002 || w < 2 || h < 2) return
    const p = easeOut(a.progress)
    const t = f.now / 1000
    const hot = dark ? '251,146,60' : '234,88,12'
    ctx.save()

    // Warmth creeping in from the edges: amber inside, deep orange at the rim.
    heatVignette(ctx, w, h, dark, k, lerp(0.98, 0.5, smooth(0, 1, a.progress)))

    // Heat coming up off the ground.
    const ground = ctx.createLinearGradient(0, h, 0, h * 0.62)
    ground.addColorStop(0, rgba(hot, (dark ? 0.16 : 0.12) * k * p))
    ground.addColorStop(1, rgba(hot, 0))
    ctx.fillStyle = ground
    ctx.fillRect(0, h * 0.62, w, h * 0.38)

    // Sun glare in the top-right corner, strongest while it arrives.
    const glare = Math.pow(k, 1.5) * easeOut(a.progress / 0.5) * (1 - 0.35 * smooth(0.75, 1, a.progress))
    if (glare > 0.01) {
      const R = Math.max(w, h) * 0.62
      const cx = w * 1.02
      const cy = -h * 0.04
      const sun = dark ? '255,236,190' : '255,196,70'
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R)
      g.addColorStop(0, rgba(sun, (dark ? 0.78 : 0.62) * glare))
      g.addColorStop(0.1, rgba(sun, (dark ? 0.46 : 0.4) * glare))
      g.addColorStop(0.32, rgba(hot, (dark ? 0.16 : 0.12) * glare))
      g.addColorStop(1, rgba(hot, 0))
      ctx.fillStyle = g
      ctx.fillRect(cx - R, cy - R, R * 2, R * 2)

      // A few faint flare rings down the diagonal.
      if (dark) {
        ctx.globalCompositeOperation = 'lighter'
        const dx = w * 0.5 - cx
        const dy = h * 0.5 - cy
        const rings: [number, number, number][] = [
          [0.3, 26, 0.07],
          [0.46, 12, 0.09],
          [0.58, 44, 0.04],
        ]
        for (const [at, rad, al] of rings) {
          ctx.beginPath()
          ctx.arc(cx + dx * at, cy + dy * at, rad, 0, TAU)
          ctx.fillStyle = rgba(sun, al * glare)
          ctx.fill()
        }
        ctx.globalCompositeOperation = 'source-over'
      }
    }

    // Shimmer: thin wavy wisps rising and fading, mostly near the edges.
    const shimmer = dark ? '255,224,178' : '194,65,12'
    const reveal = lerp(1.05, -0.1, p)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const list = wisps(a.seed)
    for (let i = 0; i < list.length; i++) {
      const wsp = list[i]
      const local = (t + wsp.offset * wsp.life) / wsp.life
      const cycle = Math.floor(local)
      const age = local - cycle
      const spawn = wispSpawn(i, cycle, w, h)
      const y0 = spawn.y - age * wsp.speed * wsp.life
      const x0 = spawn.x + Math.sin(t * 0.7 + wsp.phase) * 6
      const edge = 1 - inset(x0, y0 - wsp.len / 2, w, h)
      const shown = smooth(reveal, reveal + 0.25, edge)
      const alpha = (dark ? 0.6 : 0.7) * Math.sqrt(k) * Math.sin(Math.PI * age) * edgeWeight(x0, y0, w, h, 0.1, 0.7) * shown
      if (alpha < 0.01) continue
      const g = ctx.createLinearGradient(0, y0, 0, y0 - wsp.len)
      g.addColorStop(0, rgba(shimmer, 0))
      g.addColorStop(0.45, rgba(shimmer, alpha))
      g.addColorStop(1, rgba(shimmer, 0))
      ctx.strokeStyle = g
      ctx.lineWidth = wsp.width
      ctx.beginPath()
      const steps = Math.max(6, Math.round(wsp.len / 6))
      for (let j = 0; j <= steps; j++) {
        const s = j / steps
        const y = y0 - s * wsp.len
        const x = x0 + Math.sin(j * wsp.freq * 6 + t * 3.1 + wsp.phase) * wsp.amp * (0.45 + 0.55 * s)
        if (j === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }

    ctx.restore()
  },
}

// ---------------------------------------------------------------------------
// Cold: frost ferns grow in from the corners and along the borders, a blue
// vignette, a frosted rim, and a few ice crystals drifting down.
// ---------------------------------------------------------------------------

interface FrostSeg {
  x1: number
  y1: number
  x2: number
  y2: number
  /** Growth time when the segment starts and finishes drawing. */
  t0: number
  t1: number
  depth: 0 | 1 | 2
}

interface Frost {
  segs: FrostSeg[]
  /** Growth time when the last twig finishes. */
  end: number
}

function frost(seed: number, w: number, h: number): Frost {
  return memo(`cold:${seed}:${Math.round(w)}x${Math.round(h)}`, () => {
    const r = rng(seed ^ 0x3c6ef372)
    const segs: FrostSeg[] = []
    const unit = Math.min(w, h)
    let end = 0

    // A feathery stem: a gentle curl, short side shoots at about 60 degrees on
    // both sides, shorter toward the tip, and on big ferns shoots of their own.
    const grow = (x: number, y: number, angle: number, len: number, depth: 0 | 1 | 2, maxDepth: number, t0: number, dt: number) => {
      const steps = depth === 0 ? 6 : depth === 1 ? 3 : 2
      const step = len / steps
      const curl = (r() - 0.5) * (depth === 0 ? 0.14 : 0.2)
      let cx = x
      let cy = y
      let ang = angle
      for (let j = 0; j < steps; j++) {
        ang += curl + (r() - 0.5) * 0.1
        const nx = cx + Math.cos(ang) * step
        const ny = cy + Math.sin(ang) * step
        const s0 = t0 + (dt * j) / steps
        const s1 = t0 + (dt * (j + 1)) / steps
        segs.push({ x1: cx, y1: cy, x2: nx, y2: ny, t0: s0, t1: s1, depth })
        end = Math.max(end, s1)
        if (depth < maxDepth && j >= (depth === 0 ? 1 : 0) && j < steps - 1) {
          const shoot = len * (depth === 0 ? 0.34 : 0.5) * (1 - 0.65 * (j / steps)) * (0.8 + 0.4 * r())
          for (const side of [-1, 1]) {
            if (r() < (depth === 0 ? 0.92 : 0.7)) grow(nx, ny, ang + side * (0.95 + r() * 0.2), shoot, (depth + 1) as 1 | 2, maxDepth, s1, dt * 0.5)
          }
        }
        cx = nx
        cy = ny
      }
    }

    // Ferns rooted along each border, bigger and denser toward the corners,
    // and later the farther they are from one: frost creeps in from the corners.
    const edges = [
      { x: 0, y: 0, dx: 1, dy: 0, nx: 0, ny: 1, len: w },
      { x: w, y: h, dx: -1, dy: 0, nx: 0, ny: -1, len: w },
      { x: 0, y: h, dx: 0, dy: -1, nx: 1, ny: 0, len: h },
      { x: w, y: 0, dx: 0, dy: 1, nx: -1, ny: 0, len: h },
    ]
    for (const e of edges) {
      let pos = 20 + r() * 30
      while (pos < e.len - 12) {
        const fromCorner = Math.min(pos, e.len - pos)
        const corner = 1 - smooth(0, unit * 0.32, fromCorner)
        if (corner > 0.35 || r() < 0.7) {
          const x = e.x + e.dx * pos - e.nx * 2
          const y = e.y + e.dy * pos - e.ny * 2
          const normal = Math.atan2(e.ny, e.nx)
          const toMiddle = Math.atan2(h / 2 - y, w / 2 - x)
          let ang = normal + (r() - 0.5) * 1.0
          ang += Math.atan2(Math.sin(toMiddle - ang), Math.cos(toMiddle - ang)) * corner * 0.35
          const len = unit * (0.032 + 0.045 * r()) * (1 + 1.5 * corner)
          const t0 = 0.08 + 0.5 * clamp01(fromCorner / (e.len / 2)) + r() * 0.06
          grow(x, y, ang, len, 0, corner > 0.6 ? 2 : 1, t0, 0.34)
        }
        pos += lerp(84, 38, corner) * (0.7 + 0.6 * r())
      }
    }

    // The big ferns that frost each corner first.
    const corners = [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ]
    for (const [x, y] of corners) {
      const diag = Math.atan2(h / 2 - y, w / 2 - x)
      for (let n = 0; n < 2; n++) {
        const ang = diag + (n === 0 ? -1 : 1) * (0.2 + r() * 0.22)
        grow(x, y, ang, unit * (0.12 + r() * 0.05), 0, 2, r() * 0.05, 0.42)
      }
    }
    return { segs, end }
  })
}

const FROST_STYLE: { width: number; alpha: number }[] = [
  { width: 1.3, alpha: 0.7 },
  { width: 0.9, alpha: 0.52 },
  { width: 0.7, alpha: 0.38 },
]

interface FrostInk {
  /** The crystal line itself. */
  line: string
  /** A soft halo under the stems and shoots, so white frost reads on a light map too. */
  halo: string
  haloAlpha: number
}

/** Trace and stroke the ferns grown by `growth` (in frost time). */
function strokeFrost(ctx: CanvasRenderingContext2D, fr: Frost, growth: number, ink: FrostInk, k: number): void {
  ctx.lineCap = 'round'
  for (let d = 0; d < 3; d++) {
    ctx.beginPath()
    let any = false
    for (const s of fr.segs) {
      if (s.depth !== d || s.t0 >= growth) continue
      const u = s.t1 <= growth ? 1 : (growth - s.t0) / (s.t1 - s.t0)
      ctx.moveTo(s.x1, s.y1)
      ctx.lineTo(s.x1 + (s.x2 - s.x1) * u, s.y1 + (s.y2 - s.y1) * u)
      any = true
    }
    if (!any) continue
    const style = FROST_STYLE[d]
    if (d < 2) {
      ctx.strokeStyle = rgba(ink.halo, ink.haloAlpha * (d === 0 ? 1 : 0.6) * k)
      ctx.lineWidth = d === 0 ? 4.2 : 2.8
      ctx.stroke()
    }
    ctx.strokeStyle = rgba(ink.line, style.alpha * k)
    ctx.lineWidth = style.width
    ctx.stroke()
  }
}

/** The fully grown frost, kept as a bitmap so the lingering border costs one blit. */
const frostBitmaps = new Map<string, HTMLCanvasElement>()
function frostBitmap(fr: Frost, key: string, w: number, h: number, scale: number, ink: FrostInk): HTMLCanvasElement | null {
  const hit = frostBitmaps.get(key)
  if (hit) return hit
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const c = canvas.getContext('2d')
  if (!c) return null
  c.setTransform(scale, 0, 0, scale, 0, 0)
  strokeFrost(c, fr, Infinity, ink, 1)
  while (frostBitmaps.size >= 2) frostBitmaps.delete(frostBitmaps.keys().next().value as string)
  frostBitmaps.set(key, canvas)
  return canvas
}

interface Crystal {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  rot: number
  spin: number
  phase: number
}

function crystals(seed: number): Crystal[] {
  return memo(`crystals:${seed}`, () => {
    const r = rng(seed ^ 0xa54ff53a)
    return Array.from({ length: 18 }, () => ({
      x: r(),
      y: r(),
      vx: (r() - 0.5) * 14,
      vy: 7 + r() * 14,
      size: 2.6 + r() * 4.4,
      rot: r() * TAU,
      spin: (r() - 0.5) * 0.8,
      phase: r() * TAU,
    }))
  })
}

const cold: CampusRenderer = {
  draw(f, a) {
    const { ctx, width: w, height: h, dark } = f
    const k = clamp01(a.intensity)
    if (k <= 0.002 || w < 2 || h < 2) return
    const p = easeOut(a.progress)
    const t = f.now / 1000
    const ice = dark ? '96,165,250' : '59,130,246'
    const rime = dark ? '224,242,254' : '191,219,254'
    const ink: FrostInk = dark
      ? { line: '224,242,254', halo: '125,180,250', haloAlpha: 0.12 }
      : { line: '255,255,255', halo: '37,99,235', haloAlpha: 0.3 }
    ctx.save()

    vignette(ctx, w, h, ice, (dark ? 0.36 : 0.28) * k, lerp(0.99, 0.5, smooth(0, 1, a.progress)))
    edgeBand(ctx, w, h, rime, (dark ? 0.24 : 0.5) * Math.pow(k, 0.7) * p, lerp(3, 30, p) * (0.6 + 0.4 * k))

    const fr = frost(a.seed, w, h)
    if (a.progress < 1) {
      strokeFrost(ctx, fr, smooth(0, 1, a.progress) * fr.end, ink, k)
    } else {
      const scale = frameScale(ctx)
      const key = `${a.seed}:${Math.round(w)}x${Math.round(h)}@${scale}:${dark ? 'd' : 'l'}`
      const bitmap = frostBitmap(fr, key, w, h, scale, ink)
      if (bitmap) {
        ctx.globalAlpha = k
        ctx.drawImage(bitmap, 0, 0, w, h)
        ctx.globalAlpha = 1
      } else {
        strokeFrost(ctx, fr, Infinity, ink, k)
      }
    }

    // Ice crystals drifting down, brightest near the edges.
    const crystal = dark ? '240,249,255' : '37,99,235'
    ctx.lineCap = 'round'
    for (const c of crystals(a.seed)) {
      const x = wrap(c.x * (w + 40) + c.vx * t, w + 40) - 20
      const y = wrap(c.y * (h + 40) + c.vy * t, h + 40) - 20
      const twinkle = 0.65 + 0.35 * Math.sin(t * 2.2 + c.phase)
      const alpha = (dark ? 0.7 : 0.55) * k * p * twinkle * edgeWeight(x, y, w, h, 0.22, 0.7)
      if (alpha < 0.02) continue
      const rot = c.rot + c.spin * t
      ctx.strokeStyle = rgba(crystal, alpha)
      ctx.lineWidth = c.size > 5 ? 1.1 : 0.9
      ctx.beginPath()
      for (let arm = 0; arm < 6; arm++) {
        const ang = rot + (arm * TAU) / 6
        const ex = x + Math.cos(ang) * c.size
        const ey = y + Math.sin(ang) * c.size
        ctx.moveTo(x, y)
        ctx.lineTo(ex, ey)
        if (c.size > 4.5) {
          const bx = x + Math.cos(ang) * c.size * 0.58
          const by = y + Math.sin(ang) * c.size * 0.58
          const barb = c.size * 0.3
          ctx.moveTo(bx, by)
          ctx.lineTo(bx + Math.cos(ang + 0.8) * barb, by + Math.sin(ang + 0.8) * barb)
          ctx.moveTo(bx, by)
          ctx.lineTo(bx + Math.cos(ang - 0.8) * barb, by + Math.sin(ang - 0.8) * barb)
        }
      }
      ctx.stroke()
    }

    ctx.restore()
  },
}

// ---------------------------------------------------------------------------
// Wind: tapered streaks streaming in from the south-west, leaves tumbling
// with them, and a gust front that sweeps across as it arrives.
// ---------------------------------------------------------------------------

/** Screen direction the wind blows toward: up and to the right (from the south-west). */
const FLOW = -0.58
const COS = Math.cos(FLOW)
const SIN = Math.sin(FLOW)

interface Streak {
  v: number
  offset: number
  speed: number
  len: number
  width: number
  amp: number
  freq: number
  phase: number
  /** Shows while intensity is above this, so a settled wind keeps only a few. */
  rank: number
}

interface Fleck {
  v: number
  offset: number
  speed: number
  bob: number
  bobRate: number
  spin: number
  flip: number
  phase: number
  size: number
  leaf: boolean
  tone: number
  rank: number
}

const STREAKS = 64
const FLECKS = 26

function windField(seed: number): { streaks: Streak[]; flecks: Fleck[] } {
  return memo(`wind:${seed}`, () => {
    const r = rng(seed ^ 0x510e527f)
    const streaks = Array.from({ length: STREAKS }, (_, i) => ({
      v: r() - 0.5,
      offset: r(),
      speed: 260 + r() * 320,
      len: 160 + r() * 320,
      width: 1.8 + r() * 2.6,
      amp: 6 + r() * 14,
      freq: 1 / (70 + r() * 70),
      phase: r() * TAU,
      rank: (i + r() * 0.9) / STREAKS,
    }))
    const flecks = Array.from({ length: FLECKS }, (_, i) => ({
      v: r() - 0.5,
      offset: r(),
      speed: 300 + r() * 280,
      bob: 8 + r() * 22,
      bobRate: 1.2 + r() * 2,
      spin: (r() < 0.5 ? -1 : 1) * (3 + r() * 6),
      flip: 4 + r() * 7,
      phase: r() * TAU,
      size: 4.4 + r() * 3.6,
      leaf: r() < 0.7,
      tone: Math.floor(r() * 3),
      rank: (i + r() * 0.9) / FLECKS,
    }))
    return { streaks, flecks }
  })
}

/** Rotated flow coordinates (u along the wind, v across it) back to the screen. */
function toScreen(f: Frame, u: number, v: number): { x: number; y: number } {
  return { x: f.width / 2 + u * COS - v * SIN, y: f.height / 2 + u * SIN + v * COS }
}

/**
 * One tapered streak in flow coordinates: thin at both ends, fading in from the
 * tail. With a `halo`, a wider dark pass goes under it first, so a pale streak
 * still reads on the light map.
 */
function streak(ctx: CanvasRenderingContext2D, s: Streak, tail: number, len: number, v0: number, t: number, rgb: string, alpha: number, halo: string | null): void {
  const n = 12
  const top: number[] = []
  const bottom: number[] = []
  for (let j = 0; j <= n; j++) {
    const q = j / n
    const u = tail + len * q
    const v = v0 + Math.sin(u * s.freq + s.phase + t * 0.5) * s.amp
    const half = s.width * Math.pow(Math.sin(Math.PI * Math.pow(q, 0.75)), 0.8) * 0.5
    top.push(u, v - half)
    bottom.push(u, v + half)
  }
  const fill = (color: string, a: number, grow: number) => {
    const g = ctx.createLinearGradient(tail, 0, tail + len, 0)
    g.addColorStop(0, rgba(color, 0))
    g.addColorStop(0.65, rgba(color, a))
    g.addColorStop(1, rgba(color, a * 0.7))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(top[0], top[1] - grow)
    for (let j = 2; j < top.length; j += 2) ctx.lineTo(top[j], top[j + 1] - grow)
    for (let j = bottom.length - 2; j >= 0; j -= 2) ctx.lineTo(bottom[j], bottom[j + 1] + grow)
    ctx.closePath()
    ctx.fill()
  }
  if (halo) fill(halo, alpha * 0.32, s.width * 0.7)
  fill(rgb, alpha, 0)
}

const wind: CampusRenderer = {
  draw(f, a) {
    const { ctx, width: w, height: h, dark } = f
    const k = clamp01(a.intensity)
    if (k <= 0.002 || w < 2 || h < 2) return
    const t = f.now / 1000
    const D = Math.hypot(w, h)
    const arriving = a.progress < 1
    // The gust front, in flow coordinates, sweeping in from the south-west corner.
    const front = arriving ? lerp(-D / 2 - 60, D / 2 + 360, a.progress) : Infinity
    const air = dark ? '226,232,240' : '51,65,85'
    const halo = null
    const haze = dark ? '148,163,184' : '100,116,139'
    // Fewer streaks as it settles, each still bright enough to read.
    const keep = Math.pow(k, 0.8)
    const bright = Math.pow(k, 0.35)
    ctx.save()

    vignette(ctx, w, h, haze, (dark ? 0.22 : 0.2) * k, lerp(0.95, 0.55, easeOut(a.progress)))

    ctx.translate(w / 2, h / 2)
    ctx.rotate(FLOW)

    const { streaks, flecks } = windField(a.seed)

    // Broad faint gusts under the streaks, so the air itself looks like it moves.
    for (let i = 0; i < 7; i++) {
      const s = streaks[streaks.length - 1 - i]
      if (s.rank > keep + 0.1) continue
      const len = s.len * 2.6
      const span = D + len
      const head = -D / 2 + wrap(s.offset * span + s.speed * 0.6 * t, span)
      const reached = arriving ? smooth(front + 40, front - 200, head) : 1
      if (reached <= 0) continue
      const gust = { ...s, width: 26 + s.width * 7, amp: s.amp * 1.6 }
      streak(ctx, gust, head - len, len, s.v * D, t, haze, (dark ? 0.09 : 0.08) * bright * reached, null)
    }

    for (const s of streaks) {
      const shown = clamp01((keep - s.rank) / 0.08 + 1)
      if (shown <= 0) continue
      const span = D + s.len
      const head = -D / 2 + wrap(s.offset * span + s.speed * t, span)
      const reached = arriving ? smooth(front + 40, front - 160, head) : 1
      if (reached <= 0) continue
      const mid = toScreen(f, head - s.len / 2, s.v * D)
      const alpha = (dark ? 0.55 : 0.62) * bright * shown * reached * edgeWeight(mid.x, mid.y, w, h, 0.36, 0.8)
      if (alpha < 0.01) continue
      streak(ctx, s, head - s.len, s.len, s.v * D, t, air, Math.min(0.65, alpha), halo)
    }

    // The gust front itself: a ragged line of long bright streaks riding it across.
    if (arriving) {
      const lift = Math.sin(Math.PI * clamp01(a.progress)) * k
      for (let i = 0; i < 18; i++) {
        const s = streaks[i]
        const head = front - 30 - s.rank * 150 - Math.sin(s.v * 9 + t) * 20
        const len = s.len * 1.25
        const v0 = (i / 17 - 0.5) * D * 0.96 + (s.offset - 0.5) * 40
        const mid = toScreen(f, head - len / 2, v0)
        if (mid.x < -len || mid.x > w + len || mid.y < -len || mid.y > h + len) continue
        const alpha = (dark ? 0.65 : 0.58) * lift * edgeWeight(mid.x, mid.y, w, h, 0.45, 0.8)
        if (alpha < 0.01) continue
        streak(ctx, s, head - len, len, v0, t, air, Math.min(0.65, alpha), halo)
      }
    }

    // Leaves and debris tumbling along with it.
    const tones = dark ? ['176,196,120', '222,176,96', '196,146,98'] : ['86,110,48', '166,108,34', '128,84,48']
    for (const fl of flecks) {
      const shown = clamp01((Math.pow(k, 1.2) - fl.rank) / 0.1 + 1)
      if (shown <= 0) continue
      const span = D + 60
      const u = -D / 2 - 30 + wrap(fl.offset * span + fl.speed * t, span)
      const reached = arriving ? smooth(front + 20, front - 60, u) : 1
      if (reached <= 0) continue
      const v = fl.v * D + Math.sin(t * fl.bobRate + fl.phase) * fl.bob
      const at = toScreen(f, u, v)
      const alpha = (dark ? 0.85 : 0.8) * bright * shown * reached * edgeWeight(at.x, at.y, w, h, 0.4, 0.75)
      if (alpha < 0.02) continue
      ctx.save()
      ctx.translate(u, v)
      ctx.rotate(fl.spin * t + fl.phase)
      ctx.scale(1, 0.25 + 0.75 * Math.abs(Math.cos(t * fl.flip + fl.phase)))
      ctx.fillStyle = rgba(fl.leaf ? tones[fl.tone] : haze, alpha)
      ctx.beginPath()
      if (fl.leaf) {
        const L = fl.size
        ctx.moveTo(-L, 0)
        ctx.quadraticCurveTo(0, -L * 0.62, L, 0)
        ctx.quadraticCurveTo(0, L * 0.62, -L, 0)
      } else {
        ctx.rect(-fl.size * 0.4, -0.7, fl.size * 0.8, 1.4)
      }
      ctx.fill()
      ctx.restore()
    }

    ctx.restore()
  },
}

export const CAMPUS: Record<HazardKind, CampusRenderer> = { heat, cold, wind }

/** For callers that only have the args: the same as CAMPUS[a.hazard].draw. */
export function drawCampus(f: Frame, a: CampusArgs): void {
  CAMPUS[a.hazard].draw(f, a)
}
