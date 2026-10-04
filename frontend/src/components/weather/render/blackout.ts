/**
 * Cut power: a dark front with arcs crackling on its rim, leaving a dead zone
 * behind it with a crisp dashed edge and a faint hatch.
 */
import { cached, distToLine, frac, resample, rgba, TAU } from './a-shared'
import type { CellArgs, Frame, KindRenderer, Pt, TrackArgs } from './types'
import { noise1, rng } from './util'

const INDIGO = '165,180,252'
const DEEP = '79,70,229'

const patterns = new WeakMap<CanvasRenderingContext2D, { dark: boolean; pattern: CanvasPattern | null }>()

/** Diagonal hatch, one tile, cached per context and theme. */
function hatch(ctx: CanvasRenderingContext2D, dark: boolean): CanvasPattern | null {
  const hit = patterns.get(ctx)
  if (hit && hit.dark === dark) return hit.pattern
  if (typeof document === 'undefined') return null
  const size = 9
  const tile = document.createElement('canvas')
  tile.width = size * 2
  tile.height = size * 2
  const g = tile.getContext('2d')
  let pattern: CanvasPattern | null = null
  if (g) {
    g.scale(2, 2)
    g.strokeStyle = dark ? rgba(INDIGO, 0.26) : rgba(DEEP, 0.22)
    g.lineWidth = 0.9
    g.beginPath()
    // Three segments so the line wraps seamlessly across tile edges.
    for (const o of [-size, 0, size]) {
      g.moveTo(o, size)
      g.lineTo(o + size, 0)
    }
    g.stroke()
    pattern = ctx.createPattern(tile, 'repeat')
    pattern?.setTransform(new DOMMatrix().scale(0.5, 0.5))
  }
  patterns.set(ctx, { dark, pattern })
  return pattern
}

const outlines = new Map<number, { key: string; runs: Pt[][] }>()

/** The swath outline for a storm, recomputed only when its projected path or radius changes. */
function outline(seed: number, pts: readonly Pt[], r: number): Pt[][] {
  const key = `${r.toFixed(1)}:${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(';')}`
  const hit = outlines.get(seed)
  if (hit && hit.key === key) return hit.runs
  const runs = traceOutline(pts, r)
  outlines.set(seed, { key, runs })
  if (outlines.size > 32) outlines.delete(outlines.keys().next().value as number)
  return runs
}

/**
 * The outline of a swath (every point within `r` of the line), as runs of
 * points. Offset curves and end caps, with the parts that fall inside the
 * swath at sharp turns dropped.
 */
function traceOutline(pts: readonly Pt[], r: number): Pt[][] {
  const line = resample(pts, Math.max(2, Math.min(6, r / 8)))
  if (line.length === 1) {
    const ring: Pt[] = []
    const n = Math.max(24, Math.min(160, Math.round(r)))
    for (let i = 0; i <= n; i++) ring.push({ x: line[0].x + Math.cos((i / n) * TAU) * r, y: line[0].y + Math.sin((i / n) * TAU) * r })
    return [ring]
  }
  const loop: Pt[] = []
  for (const p of line) loop.push({ x: p.x + p.nx * r, y: p.y + p.ny * r })
  const end = line[line.length - 1]
  const a1 = Math.atan2(end.ny, end.nx)
  for (let i = 1; i < 16; i++) loop.push({ x: end.x + Math.cos(a1 + (i / 16) * Math.PI) * r, y: end.y + Math.sin(a1 + (i / 16) * Math.PI) * r })
  for (let i = line.length - 1; i >= 0; i--) loop.push({ x: line[i].x - line[i].nx * r, y: line[i].y - line[i].ny * r })
  const start = line[0]
  const a0 = Math.atan2(-start.ny, -start.nx)
  for (let i = 1; i <= 16; i++) loop.push({ x: start.x + Math.cos(a0 + (i / 16) * Math.PI) * r, y: start.y + Math.sin(a0 + (i / 16) * Math.PI) * r })
  const coarse = line.filter((_, i) => i % 3 === 0 || i === line.length - 1)
  const runs: Pt[][] = []
  let run: Pt[] = []
  for (const p of loop) {
    if (distToLine(p.x, p.y, coarse) >= r - 1.5) run.push(p)
    else if (run.length) {
      if (run.length > 1) runs.push(run)
      run = []
    }
  }
  if (run.length > 1) runs.push(run)
  return runs
}

function traceRuns(ctx: CanvasRenderingContext2D, runs: Pt[][]) {
  for (const run of runs) {
    ctx.moveTo(run[0].x, run[0].y)
    for (let i = 1; i < run.length; i++) ctx.lineTo(run[i].x, run[i].y)
  }
}

/** Clip to the swath: a chain of discs along the line. */
function clipSwath(ctx: CanvasRenderingContext2D, pts: readonly Pt[], r: number) {
  const line = resample(pts, Math.max(1.5, r / 3))
  ctx.beginPath()
  for (const p of line) {
    ctx.moveTo(p.x + r, p.y)
    ctx.arc(p.x, p.y, r, 0, TAU)
  }
  ctx.clip()
}

function track(f: Frame, a: TrackArgs) {
  const { ctx, dark } = f
  const r = a.radiusPx
  if (r < 1 || a.swept.length === 0) return
  const t = f.now / 1000
  const stutter = rng((a.seed ^ Math.floor(f.now / 70)) >>> 0)() < 0.08 ? 0.45 : 1
  const flicker = (0.75 + 0.25 * noise1(t * 7, a.seed)) * stutter
  const edge = dark ? INDIGO : DEEP
  const runs = outline(a.seed, a.swept, r)
  const one = a.swept.length === 1

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // The dead zone: darken, then tint indigo.
  const shadeDead = (style: string) => {
    ctx.beginPath()
    if (one) {
      ctx.arc(a.swept[0].x, a.swept[0].y, r, 0, TAU)
      ctx.fillStyle = style
      ctx.fill()
      return
    }
    ctx.moveTo(a.swept[0].x, a.swept[0].y)
    for (let i = 1; i < a.swept.length; i++) ctx.lineTo(a.swept[i].x, a.swept[i].y)
    ctx.lineWidth = r * 2
    ctx.strokeStyle = style
    ctx.stroke()
  }
  shadeDead(dark ? 'rgba(4,5,20,0.4)' : 'rgba(36,32,100,0.12)')
  shadeDead(dark ? 'rgba(99,102,241,0.1)' : 'rgba(99,102,241,0.08)')

  ctx.save()
  clipSwath(ctx, a.swept, r)
  const pattern = hatch(ctx, dark)
  if (pattern) {
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, f.width, f.height)
  }
  // Inner rim light hugging the boundary.
  ctx.beginPath()
  traceRuns(ctx, runs)
  ctx.lineWidth = Math.min(16, r * 0.3)
  ctx.strokeStyle = rgba(edge, (dark ? 0.14 : 0.1) * flicker)
  ctx.stroke()
  ctx.lineWidth = Math.min(6, r * 0.12)
  ctx.strokeStyle = rgba(edge, (dark ? 0.12 : 0.08) * flicker)
  ctx.stroke()
  ctx.restore()

  // Crisp dashed boundary, slowly marching.
  ctx.beginPath()
  traceRuns(ctx, runs)
  ctx.setLineDash([7, 5])
  ctx.lineDashOffset = -f.now / 80
  ctx.lineWidth = 1.5
  ctx.strokeStyle = rgba(edge, (dark ? 0.92 : 0.85) * flicker)
  ctx.stroke()
  ctx.setLineDash([])

  // A spark now and then where the edge shorts out.
  const slot = Math.floor(f.now / 110)
  const sr = rng((a.seed ^ Math.imul(slot, 0x9e3779b1)) >>> 0)
  const total = runs.reduce((n, run) => n + run.length, 0)
  if (total > 0 && sr() < 0.55) {
    let pick = Math.floor(sr() * total)
    let run = runs[0]
    for (const candidate of runs) {
      if (pick < candidate.length) {
        run = candidate
        break
      }
      pick -= candidate.length
    }
    const p = run[Math.min(run.length - 1, pick)]
    const zig = new Path2D()
    zig.moveTo(p.x, p.y)
    let x = p.x
    let y = p.y
    for (let i = 0; i < 3; i++) {
      x += (sr() - 0.5) * 10
      y += (sr() - 0.5) * 10
      zig.lineTo(x, y)
    }
    if (dark) ctx.globalCompositeOperation = 'lighter'
    ctx.lineWidth = 3
    ctx.strokeStyle = rgba(edge, 0.3)
    ctx.stroke(zig)
    ctx.lineWidth = 1
    ctx.strokeStyle = dark ? 'rgba(240,242,255,0.9)' : rgba(DEEP, 0.9)
    ctx.stroke(zig)
  }
  ctx.restore()
}

interface Arc {
  span: number
  offset: number
  seed: number
}

function arcs(seed: number, level: number): Arc[] {
  return cached(`blackout:arcs:${seed}:${level}`, () => {
    const r = rng(seed ^ 0xa4c)
    const out: Arc[] = []
    for (let i = 0; i < 6 + level * 2; i++) out.push({ span: 0.25 + r() * 0.5, offset: r(), seed: Math.floor(r() * 1e6) })
    return out
  })
}

function cell(f: Frame, a: CellArgs) {
  const { ctx, dark } = f
  const r = a.radiusPx
  const k = a.intensity
  if (r < 2 || k <= 0) return
  const lv = Math.max(0, Math.min(2, a.level))
  const t = f.now / 1000
  const { x: cx, y: cy } = a.head
  const edge = dark ? INDIGO : DEEP

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Dark disc: the lights going out, deepest just inside the rim.
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.12)
  const ink = dark ? '3,4,16' : '24,22,70'
  g.addColorStop(0, rgba(ink, (dark ? 0.32 : 0.12) * k))
  g.addColorStop(0.75, rgba(ink, (dark ? 0.5 : 0.2) * k))
  g.addColorStop(0.89, rgba(ink, (dark ? 0.6 : 0.26) * k))
  g.addColorStop(1, rgba(ink, 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(cx, cy, r * 1.12, 0, TAU)
  ctx.fill()

  // Power draining inward: rings collapsing to the centre.
  for (let i = 0; i < 3; i++) {
    const ph = frac(t * 0.55 + i / 3)
    const rad = r * (1 - ph) * 0.95
    if (rad < 2) continue
    ctx.beginPath()
    ctx.arc(cx, cy, rad, 0, TAU)
    ctx.lineWidth = 1
    ctx.strokeStyle = rgba(edge, (dark ? 0.28 : 0.22) * ph * (1 - ph) * 2 * k)
    ctx.stroke()
  }

  ctx.save()
  if (dark) ctx.globalCompositeOperation = 'lighter'
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, TAU)
  ctx.lineWidth = 7
  ctx.strokeStyle = rgba(edge, 0.1 * k)
  ctx.stroke()

  // Flickering rim in segments, brighter on the leading side when it moves.
  const segs = 32
  const ft = f.now * 0.012
  ctx.lineWidth = 1.6
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU
    const lead = a.stationary ? 0.85 : 0.55 + 0.45 * Math.cos(a0 - a.heading)
    const flick = noise1(i * 1.7 + ft, a.seed) * noise1(i * 0.6 - ft * 1.6, a.seed + 7)
    ctx.strokeStyle = rgba(edge, (0.25 + 0.75 * flick) * lead * k)
    ctx.beginPath()
    ctx.arc(cx, cy, r, a0, a0 + TAU / segs - 0.015)
    ctx.stroke()
  }

  // Arcs crackling along the rim, re-struck every few frames.
  const slot = Math.floor(f.now / 75)
  const glow = new Path2D()
  for (const arc of arcs(a.seed, lv)) {
    const ar = rng((arc.seed ^ Math.imul(slot, 0x85ebca6b)) >>> 0)
    if (ar() > 0.72) continue
    const centre = a.stationary ? (arc.offset + ar() * 0.3) * TAU : a.heading + (arc.offset - 0.5) * Math.PI * 1.7 + (ar() - 0.5) * 0.4
    const span = arc.span * (0.7 + ar() * 0.6)
    const steps = Math.max(6, Math.round((span * r) / 5))
    for (let i = 0; i <= steps; i++) {
      const th = centre - span / 2 + (span * i) / steps
      const jitter = i === 0 || i === steps ? 0 : (ar() - 0.5) * r * 0.07 + (ar() < 0.1 ? r * 0.05 : 0)
      const x = cx + Math.cos(th) * (r + jitter)
      const y = cy + Math.sin(th) * (r + jitter)
      if (i) glow.lineTo(x, y)
      else glow.moveTo(x, y)
    }
    // A branch spitting off outward.
    if (ar() < 0.5) {
      const th = centre + (ar() - 0.5) * span
      let x = cx + Math.cos(th) * r
      let y = cy + Math.sin(th) * r
      glow.moveTo(x, y)
      for (let i = 0; i < 3; i++) {
        const out = r * (0.03 + ar() * 0.05)
        const side = (ar() - 0.5) * 0.9
        x += Math.cos(th + side) * out
        y += Math.sin(th + side) * out
        glow.lineTo(x, y)
      }
    }
  }
  ctx.lineWidth = dark ? 5 : 4.5
  ctx.strokeStyle = rgba(edge, (dark ? 0.3 : 0.6) * k)
  ctx.stroke(glow)
  ctx.shadowColor = dark ? 'rgba(165,180,252,0.9)' : 'rgba(79,70,229,0.7)'
  ctx.shadowBlur = 6
  ctx.lineWidth = 1.2
  ctx.strokeStyle = rgba(dark ? '242,244,255' : '255,255,255', 0.95 * k)
  ctx.stroke(glow)
  ctx.restore()

  // Last lights winking out just inside the front.
  const lights = rng((a.seed ^ Math.floor(f.now / 140)) >>> 0)
  ctx.fillStyle = dark ? rgba('255,226,160', 0.8 * k) : rgba('255,200,90', 0.9 * k)
  for (let i = 0; i < 6 + lv * 3; i++) {
    const th = a.stationary ? lights() * TAU : a.heading + (lights() - 0.5) * 2.4
    const rad = r * (0.72 + lights() * 0.24)
    const size = 0.9 + lights() * 0.8
    if (lights() < 0.45) continue
    ctx.beginPath()
    ctx.arc(cx + Math.cos(th) * rad, cy + Math.sin(th) * rad, size, 0, TAU)
    ctx.fill()
  }
  ctx.restore()
}

export const blackout: KindRenderer = { track, cell }
