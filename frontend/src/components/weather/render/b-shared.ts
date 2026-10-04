/**
 * Helpers for the ice, flood, blizzard and closure renderers: ragged footprints
 * built from noisy discs, their outlines, seeded scatter grids and sparkles.
 */
import { STORM_SPECS, type StormKind } from '../../../lib/weather/types'
import type { Pt } from './types'
import { noise2 } from './util'

export const TAU = Math.PI * 2

export function rgba(rgb: string, alpha: number): string {
  return `rgba(${rgb},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function frac(v: number): number {
  return v - Math.floor(v)
}

/** Integer hash to [0, 1). Different `seed`s give independent channels. */
export function hash2(i: number, j: number, seed: number): number {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(seed | 0, -1640531535)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Bounded memo for per-seed data. */
const memo = new Map<string, unknown>()
export function cached<T>(key: string, make: () => T): T {
  const hit = memo.get(key)
  if (hit !== undefined) return hit as T
  const value = make()
  if (memo.size > 300) memo.delete(memo.keys().next().value as string)
  memo.set(key, value)
  return value
}

/** Small LRU for geometry that only changes when the map moves. */
const shapes = new Map<string, unknown>()
export function lru<T>(key: string, make: () => T): T {
  const hit = shapes.get(key)
  if (hit !== undefined) {
    shapes.delete(key)
    shapes.set(key, hit)
    return hit as T
  }
  const value = make()
  if (shapes.size > 120) shapes.delete(shapes.keys().next().value as string)
  shapes.set(key, value)
  return value
}

export function ptsKey(pts: readonly Pt[]): string {
  let k = ''
  for (const p of pts) k += `${p.x.toFixed(1)},${p.y.toFixed(1)};`
  return k
}

/** The kind's full footprint in px. Texture scales with it, so pan and zoom do not make it crawl. */
export function unitPx(kind: StormKind, level: number, pxPerMeter: number, fallback: number): number {
  const spec = STORM_SPECS[kind]
  const u = (spec.radius[level] ?? spec.radius[0]) * pxPerMeter
  return u > 0 && Number.isFinite(u) ? u : fallback
}

export interface Sample {
  x: number
  y: number
  angle: number
  s: number
}

/** Points every `step` px along a polyline, with a smoothed direction. */
export function resample(pts: readonly Pt[], step: number, smooth = 2): Sample[] {
  if (pts.length === 0) return []
  if (pts.length === 1) return [{ x: pts[0].x, y: pts[0].y, angle: 0, s: 0 }]
  const out: Sample[] = []
  let s = 0
  let next = 0
  let angle = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 1e-6) continue
    angle = Math.atan2(b.y - a.y, b.x - a.x)
    while (next <= s + len) {
      const f = (next - s) / len
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, angle, s: next })
      next += step
    }
    s += len
  }
  const last = pts[pts.length - 1]
  if (out.length > 1 && s - out[out.length - 1].s < step * 0.3) out.pop()
  out.push({ x: last.x, y: last.y, angle, s })
  if (smooth > 0 && out.length > 2) {
    const cx = out.map((p) => Math.cos(p.angle))
    const cy = out.map((p) => Math.sin(p.angle))
    for (let i = 0; i < out.length; i++) {
      let x = 0
      let y = 0
      for (let k = Math.max(0, i - smooth); k <= Math.min(out.length - 1, i + smooth); k++) {
        x += cx[k]
        y += cy[k]
      }
      out[i].angle = Math.atan2(y, x)
    }
  }
  return out
}

export function distToPath(x: number, y: number, pts: readonly Pt[]): number {
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

// ---------------------------------------------------------------------------
// Ragged footprints: a union of noisy discs strung along the path.
// ---------------------------------------------------------------------------

export interface BlobOpts {
  seed: number
  /** Edge raggedness as a share of the radius. */
  rough: number
  /** Noise scale in px, usually unitPx(). */
  unit: number
  /** Noise anchor, usually the first point of the full path. */
  origin: Pt
  /** Radius multiplier, for inner contours and halos. */
  scale?: number
  /** Noise features per unit. */
  freq?: number
}

export interface Blob {
  /** One closed polygon per disc, xy pairs. */
  polys: Float32Array[]
  /** The visible edge of the union, as open runs of xy pairs. Worked out on first use. */
  readonly outline: Float32Array[]
}

interface Disc {
  x: number
  y: number
  r: number
}

function edgeRadius(d: Disc, theta: number, o: BlobOpts): number {
  const bx = d.x + d.r * Math.cos(theta)
  const by = d.y + d.r * Math.sin(theta)
  const f = (o.freq ?? 2.4) / o.unit
  const u = (bx - o.origin.x) * f
  const v = (by - o.origin.y) * f
  const n = noise2(u, v, o.seed) * 0.68 + noise2(u * 2.3 + 17.3, v * 2.3 - 5.1, o.seed + 11) * 0.32
  return d.r * (1 + o.rough * (2 * n - 1))
}

/** The ragged footprint of `pts` at radius `r`. Cached while the map holds still. */
export function blob(pts: readonly Pt[], r: number, o: BlobOpts): Blob {
  const scale = o.scale ?? 1
  const rr = r * scale
  const key = `${o.seed}|${o.rough}|${o.freq ?? 0}|${rr.toFixed(1)}|${o.unit.toFixed(1)}|${o.origin.x.toFixed(1)},${o.origin.y.toFixed(1)}|${ptsKey(pts)}`
  return lru(key, () => buildBlob(pts, rr, o))
}

function buildBlob(pts: readonly Pt[], rr: number, o: BlobOpts): Blob {
  if (pts.length === 0 || rr <= 0) return { polys: [], outline: [] }
  const step = Math.max(3, rr * 0.38)
  const discs: Disc[] = resample(pts, step, 0).map((s) => ({ x: s.x, y: s.y, r: rr }))
  const sides = Math.round(clamp(rr * 0.42, 24, 96))
  const polys = discs.map((d) => {
    const out = new Float32Array(sides * 2)
    for (let k = 0; k < sides; k++) {
      const th = (k / sides) * TAU
      const er = edgeRadius(d, th, o)
      out[k * 2] = d.x + Math.cos(th) * er
      out[k * 2 + 1] = d.y + Math.sin(th) * er
    }
    return out
  })
  let outline: Float32Array[] | null = null
  return {
    polys,
    get outline() {
      outline ??= traceOutline(discs, polys, o)
      return outline
    },
  }
}

/** The visible edge of a union of noisy discs: each polygon's vertices that no neighbour covers. */
function traceOutline(discs: Disc[], polys: Float32Array[], o: BlobOpts): Float32Array[] {
  const lo = 1 - o.rough
  const hi = 1 + o.rough
  const near = discs.map((d, i) => {
    const list: number[] = []
    discs.forEach((e, j) => {
      if (j !== i && Math.hypot(e.x - d.x, e.y - d.y) < (d.r + e.r) * hi) list.push(j)
    })
    return list
  })
  const inside = (x: number, y: number, i: number): boolean => {
    for (const j of near[i]) {
      const e = discs[j]
      const dist = Math.hypot(x - e.x, y - e.y)
      if (dist < e.r * lo) return true
      if (dist > e.r * hi) continue
      if (dist < edgeRadius(e, Math.atan2(y - e.y, x - e.x), o) - 0.25) return true
    }
    return false
  }
  const outline: Float32Array[] = []
  polys.forEach((poly, i) => {
    const n = poly.length / 2
    const flags: boolean[] = []
    for (let k = 0; k < n; k++) flags.push(!inside(poly[k * 2], poly[k * 2 + 1], i))
    const start = flags.indexOf(false)
    if (start < 0) {
      const loop = new Float32Array(n * 2 + 2)
      loop.set(poly)
      loop[n * 2] = poly[0]
      loop[n * 2 + 1] = poly[1]
      outline.push(loop)
      return
    }
    let run: number[] | null = null
    for (let m = 1; m <= n; m++) {
      const k = (start + m) % n
      const prev = (start + m - 1) % n
      if (flags[k]) {
        if (!run) {
          run = []
          const [cx, cy] = crossing(poly, k, prev, i, inside)
          run.push(cx, cy)
        }
        run.push(poly[k * 2], poly[k * 2 + 1])
      } else if (run) {
        const [cx, cy] = crossing(poly, prev, k, i, inside)
        run.push(cx, cy)
        outline.push(Float32Array.from(run))
        run = null
      }
    }
    if (run) outline.push(Float32Array.from(run))
  })
  return outline
}

/** Where the edge from an outside vertex to an inside one crosses into a neighbour. */
function crossing(poly: Float32Array, out: number, inn: number, i: number, inside: (x: number, y: number, i: number) => boolean): [number, number] {
  let ax = poly[out * 2]
  let ay = poly[out * 2 + 1]
  let bx = poly[inn * 2]
  let by = poly[inn * 2 + 1]
  for (let it = 0; it < 5; it++) {
    const mx = (ax + bx) / 2
    const my = (ay + by) / 2
    if (inside(mx, my, i)) {
      bx = mx
      by = my
    } else {
      ax = mx
      ay = my
    }
  }
  return [(ax + bx) / 2, (ay + by) / 2]
}

/** Add the footprint's filled area to the current path (nonzero union). */
export function traceBlob(ctx: CanvasPath, b: Blob): void {
  for (const p of b.polys) {
    ctx.moveTo(p[0], p[1])
    for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k], p[k + 1])
    ctx.closePath()
  }
}

/** Add the footprint's visible edge to the current path, for strokes. */
export function traceRuns(ctx: CanvasPath, runs: readonly Float32Array[]): void {
  for (const r of runs) {
    if (r.length < 4) continue
    ctx.moveTo(r[0], r[1])
    for (let k = 2; k < r.length; k += 2) ctx.lineTo(r[k], r[k + 1])
  }
}

/** Fill a footprint in one call. */
export function fillBlob(ctx: CanvasRenderingContext2D, b: Blob, style: string | CanvasGradient): void {
  ctx.beginPath()
  traceBlob(ctx, b)
  ctx.fillStyle = style
  ctx.fill()
}

/** Radius multiplier of noisyLoop at angle `th`, for decorations that hug its edge. */
export function loopRadius(th: number, rough: number, seed: number, t: number): number {
  const c = Math.cos(th)
  const s = Math.sin(th)
  const n = noise2(c * 1.7 + t, s * 1.7 - t * 0.6, seed) * 0.6 + noise2(c * 4.1 - t * 1.3, s * 4.1 + t, seed + 5) * 0.4
  return 1 + rough * (2 * n - 1)
}

/** A wobbling closed shape around a point; `t` animates the wobble. Squash stretches it along `angle`. */
export function noisyLoop(
  ctx: CanvasPath,
  x: number,
  y: number,
  r: number,
  rough: number,
  seed: number,
  t: number,
  stretch = 1,
  squash = 1,
  angle = 0,
): void {
  const sides = Math.round(clamp(r * 0.45, 28, 110))
  const ca = Math.cos(angle)
  const sa = Math.sin(angle)
  for (let k = 0; k <= sides; k++) {
    const th = (k / sides) * TAU
    const c = Math.cos(th)
    const s = Math.sin(th)
    const rr = r * loopRadius(th, rough, seed, t)
    const lx = c * rr * stretch
    const ly = s * rr * squash
    const px = x + lx * ca - ly * sa
    const py = y + lx * sa + ly * ca
    if (k === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
}

// ---------------------------------------------------------------------------
// Seeded scatter inside a swath.
// ---------------------------------------------------------------------------

export interface Site {
  i: number
  j: number
  x: number
  y: number
  /** Stable 0..1 per site. */
  h: number
}

/**
 * A jittered grid anchored to `origin`, keeping the sites within `reach` px of the path
 * and, when `view` is given, on screen.
 */
export function gridSites(pts: readonly Pt[], reach: number, cell: number, origin: Pt, seed: number, view?: { w: number; h: number }): Site[] {
  if (pts.length === 0 || cell <= 0) return []
  const key = `g|${seed}|${reach.toFixed(1)}|${cell.toFixed(2)}|${origin.x.toFixed(1)},${origin.y.toFixed(1)}|${view ? `${view.w}x${view.h}` : ''}|${ptsKey(pts)}`
  return lru(key, () => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of pts) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    let x0 = minX - reach
    let x1 = maxX + reach
    let y0 = minY - reach
    let y1 = maxY + reach
    if (view) {
      x0 = Math.max(x0, -cell * 2)
      y0 = Math.max(y0, -cell * 2)
      x1 = Math.min(x1, view.w + cell * 2)
      y1 = Math.min(y1, view.h + cell * 2)
      if (x1 <= x0 || y1 <= y0) return []
    }
    const i0 = Math.floor((x0 - origin.x) / cell) - 1
    const i1 = Math.ceil((x1 - origin.x) / cell) + 1
    const j0 = Math.floor((y0 - origin.y) / cell) - 1
    const j1 = Math.ceil((y1 - origin.y) / cell) + 1
    const out: Site[] = []
    if ((i1 - i0) * (j1 - j0) > 40000) return out
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const [sx, sy] = siteAt(i, j, seed)
        const x = origin.x + sx * cell
        const y = origin.y + sy * cell
        if (distToPath(x, y, pts) <= reach) out.push({ i, j, x, y, h: hash2(i, j, seed + 3) })
      }
    }
    return out
  })
}

/** Jittered site position for grid cell (i, j), in grid units. */
export function siteAt(i: number, j: number, seed: number): [number, number] {
  return [i + 0.1 + 0.8 * hash2(i, j, seed), j + 0.1 + 0.8 * hash2(i, j, seed + 1)]
}

/** A four-point star with slightly fat rays, added to the current path. */
export function star(ctx: CanvasPath, x: number, y: number, size: number, waist = 0.14): void {
  const w = size * waist
  ctx.moveTo(x, y - size)
  ctx.quadraticCurveTo(x + w, y - w, x + size, y)
  ctx.quadraticCurveTo(x + w, y + w, x, y + size)
  ctx.quadraticCurveTo(x - w, y + w, x - size, y)
  ctx.quadraticCurveTo(x - w, y - w, x, y - size)
  ctx.closePath()
}

/** Brief, sharp twinkle in 0..1 from a slow clock. */
export function twinkle(t: number, rate: number, phase: number, sharpness = 10): number {
  const s = Math.sin(t * rate + phase)
  return s > 0 ? Math.pow(s, sharpness) : 0
}
