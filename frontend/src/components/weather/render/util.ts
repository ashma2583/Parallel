/** Small helpers every renderer shares: seeded randomness, noise, and swath strokes. */
import type { Pt } from './types'

/** Deterministic PRNG. Same seed, same sequence. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function lattice(i: number, seed: number): number {
  let h = Math.imul(i ^ seed, 0x27d4eb2d)
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  return ((h >>> 0) % 10000) / 10000
}

/** Smooth 1D value noise in [0, 1]. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  return lattice(i, seed) * (1 - u) + lattice(i + 1, seed) * u
}

/** Smooth 2D value noise in [0, 1]. */
export function noise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const n = (a: number, b: number) => lattice(a * 73856093 + b * 19349663, seed)
  const top = n(xi, yi) * (1 - u) + n(xi + 1, yi) * u
  const bottom = n(xi, yi + 1) * (1 - u) + n(xi + 1, yi + 1) * u
  return top * (1 - v) + bottom * v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t))
}

/** Trace a polyline into the current path. A single point traces a zero-length stroke. */
export function tracePath(ctx: CanvasRenderingContext2D, pts: readonly Pt[]): void {
  if (pts.length === 0) return
  ctx.moveTo(pts[0].x, pts[0].y)
  if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
}

/**
 * Fill the swath of a polyline: every point within `radius` px of it.
 * Done as one fat round-capped stroke, which is exactly that shape.
 */
export function swath(ctx: CanvasRenderingContext2D, pts: readonly Pt[], radius: number, style: string | CanvasGradient | CanvasPattern): void {
  if (pts.length === 0 || radius <= 0) return
  ctx.save()
  ctx.beginPath()
  tracePath(ctx, pts)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = radius * 2
  ctx.strokeStyle = style
  ctx.stroke()
  ctx.restore()
}

/** A soft-edged swath: several strokes, widest and faintest first. `rgb` is "r,g,b". */
export function softSwath(ctx: CanvasRenderingContext2D, pts: readonly Pt[], radius: number, rgb: string, alpha: number, layers = 5): void {
  for (let i = 0; i < layers; i++) {
    const k = 1 - i / layers
    swath(ctx, pts, radius * (0.55 + 0.45 * k), `rgba(${rgb},${(alpha / layers) * (1 + i * 0.35)})`)
  }
}

export function pathLengthPx(pts: readonly Pt[]): number {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return total
}

/** Point and direction `s` px along a polyline. */
export function alongPx(pts: readonly Pt[], s: number): { p: Pt; angle: number } {
  if (pts.length === 0) return { p: { x: 0, y: 0 }, angle: 0 }
  if (pts.length === 1) return { p: pts[0], angle: 0 }
  let remaining = Math.max(0, s)
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (remaining <= len || i === pts.length - 1) {
      const f = len === 0 ? 0 : Math.min(1, remaining / len)
      return { p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, angle: Math.atan2(b.y - a.y, b.x - a.x) }
    }
    remaining -= len
  }
  const a = pts[pts.length - 2]
  const b = pts[pts.length - 1]
  return { p: b, angle: Math.atan2(b.y - a.y, b.x - a.x) }
}

/** Jagged lightning bolt from a to b, with optional forks. Returns the main channel. */
export function boltPoints(a: Pt, b: Pt, random: () => number, roughness = 0.22, depth = 6): Pt[] {
  let pts: Pt[] = [a, b]
  let spread = Math.hypot(b.x - a.x, b.y - a.y) * roughness
  for (let d = 0; d < depth; d++) {
    const next: Pt[] = [pts[0]]
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1]
      const q = pts[i]
      const dx = q.x - p.x
      const dy = q.y - p.y
      const len = Math.hypot(dx, dy) || 1
      const off = (random() - 0.5) * spread
      next.push({ x: (p.x + q.x) / 2 + (-dy / len) * off, y: (p.y + q.y) / 2 + (dx / len) * off }, q)
    }
    pts = next
    spread *= 0.55
  }
  return pts
}
