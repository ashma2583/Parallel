/** Helpers shared by the tornado, thunderstorm, lightning and blackout renderers. */
import type { Pt } from './types'

export const TAU = Math.PI * 2

/** A point on a resampled polyline: position, unit normal (left of travel) and running length. */
export interface Sample {
  x: number
  y: number
  nx: number
  ny: number
  s: number
}

/** Points every `step` px along a polyline, with smoothed normals. Capped at ~800 samples. */
export function resample(pts: readonly Pt[], step: number): Sample[] {
  const out: Sample[] = []
  if (pts.length === 0) return out
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  if (pts.length === 1 || total < 0.5) {
    out.push({ x: pts[0].x, y: pts[0].y, nx: 0, ny: -1, s: 0 })
    return out
  }
  const gap = Math.max(step, total / 800, 0.5)
  let s = 0
  let next = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    while (next <= s + len) {
      const f = len === 0 ? 0 : (next - s) / len
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, nx: 0, ny: 0, s: next })
      next += gap
    }
    s += len
  }
  const last = pts[pts.length - 1]
  if (total - out[out.length - 1].s > 0.25) out.push({ x: last.x, y: last.y, nx: 0, ny: 0, s: total })
  const n = out.length
  let px = 0
  let py = -1
  for (let i = 0; i < n; i++) {
    const p = out[Math.max(0, i - 2)]
    const q = out[Math.min(n - 1, i + 2)]
    const tx = q.x - p.x
    const ty = q.y - p.y
    const l = Math.hypot(tx, ty)
    if (l > 0) {
      px = ty / l
      py = -tx / l
    }
    out[i].nx = px
    out[i].ny = py
  }
  return out
}

/** The sample nearest `s` px along a resampled line. */
export function sampleAt(line: readonly Sample[], s: number): Sample {
  if (line.length === 1) return line[0]
  const step = line[1].s - line[0].s || 1
  return line[Math.max(0, Math.min(line.length - 1, Math.round(s / step)))]
}

const store = new Map<string, unknown>()

/** Module-level memo for seeded particle sets and other per-storm data. */
export function cached<T>(key: string, make: () => T): T {
  const hit = store.get(key)
  if (hit !== undefined) return hit as T
  const value = make()
  store.set(key, value)
  if (store.size > 96) store.delete(store.keys().next().value as string)
  return value
}

/** Trace a closed, smoothed loop through points (quadratic curves between midpoints). */
export function traceLoop(ctx: CanvasPath, xs: ArrayLike<number>, ys: ArrayLike<number>): void {
  const n = xs.length
  if (n < 3) return
  ctx.moveTo((xs[n - 1] + xs[0]) / 2, (ys[n - 1] + ys[0]) / 2)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    ctx.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[j]) / 2, (ys[i] + ys[j]) / 2)
  }
  ctx.closePath()
}

/** Trace an open polyline from flat x/y arrays. */
export function traceLine(ctx: CanvasRenderingContext2D, pts: readonly Pt[], from = 0, to = pts.length): void {
  if (to - from < 1) return
  ctx.moveTo(pts[from].x, pts[from].y)
  for (let i = from + 1; i < to; i++) ctx.lineTo(pts[i].x, pts[i].y)
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function frac(x: number): number {
  return x - Math.floor(x)
}

/** "r,g,b" plus alpha, as a CSS colour. */
export function rgba(rgb: string, alpha: number): string {
  return `rgba(${rgb},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

/** Distance from a point to a polyline. */
export function distToLine(x: number, y: number, pts: readonly Pt[]): number {
  if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y)
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = dx * dx + dy * dy
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len))
    const d = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy))
    if (d < best) best = d
  }
  return best
}

/** A glowing forked bolt: blue halo, warm inner glow, white core. `scale` sets the widths. */
export function strokeBolt(ctx: CanvasRenderingContext2D, main: Pt[], forks: Pt[][], dark: boolean, alpha: number, scale: number) {
  const all = new Path2D()
  const thin = new Path2D()
  main.forEach((p, i) => (i ? all.lineTo(p.x, p.y) : all.moveTo(p.x, p.y)))
  for (const fork of forks) fork.forEach((p, i) => (i ? thin.lineTo(p.x, p.y) : thin.moveTo(p.x, p.y)))
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (dark) {
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = rgba('120,160,255', 0.28 * alpha)
    ctx.lineWidth = 7 * scale
    ctx.stroke(all)
    ctx.lineWidth = 4 * scale
    ctx.stroke(thin)
    ctx.strokeStyle = rgba('255,236,170', 0.45 * alpha)
    ctx.lineWidth = 3 * scale
    ctx.stroke(all)
  } else {
    ctx.strokeStyle = rgba('90,80,230', 0.22 * alpha)
    ctx.lineWidth = 8 * scale
    ctx.stroke(all)
    ctx.lineWidth = 4 * scale
    ctx.stroke(thin)
    ctx.strokeStyle = rgba('50,40,170', 0.85 * alpha)
    ctx.lineWidth = 3.2 * scale
    ctx.stroke(all)
    ctx.lineWidth = 2 * scale
    ctx.stroke(thin)
  }
  ctx.shadowColor = dark ? 'rgba(160,190,255,1)' : 'rgba(80,70,255,0.9)'
  ctx.shadowBlur = 10 * scale
  ctx.strokeStyle = rgba('255,255,255', alpha)
  ctx.lineWidth = 1.5 * scale
  ctx.stroke(all)
  ctx.lineWidth = 0.9 * scale
  ctx.stroke(thin)
  ctx.restore()
}
