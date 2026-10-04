/**
 * Helpers for the campus-wide renderers: easing, edge masks that keep the
 * middle of the map clear, vignettes, and a small cache for seeded geometry.
 */

export const TAU = Math.PI * 2

export function rgba(rgb: string, alpha: number): string {
  return `rgba(${rgb},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

export function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t))
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function smooth(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

export function easeOut(t: number): number {
  const u = 1 - clamp01(t)
  return 1 - u * u * u
}

/** Positive modulo. */
export function wrap(v: number, span: number): number {
  return ((v % span) + span) % span
}

/** Integer hash to [0, 1). Different `salt`s give independent channels. */
export function hash3(i: number, j: number, salt: number): number {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(salt | 0, -1640531535)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** 0 on the screen edge, 1 in the middle. Rectangular, so every edge counts the same. */
export function inset(x: number, y: number, w: number, h: number): number {
  return clamp01(Math.min(x, w - x, y, h - y) / (Math.min(w, h) / 2))
}

/** How strongly an effect shows at (x, y): 1 at the edges, `floor` across the middle. */
export function edgeWeight(x: number, y: number, w: number, h: number, floor = 0.3, reach = 0.75): number {
  return floor + (1 - floor) * (1 - smooth(0, reach, inset(x, y, w, h)))
}

/**
 * Elliptical vignette: clear inside `inner` (0..1 of the way to the edge) and
 * rising to `alpha` at the edges and beyond into the corners.
 */
export function vignette(ctx: CanvasRenderingContext2D, w: number, h: number, rgb: string, alpha: number, inner: number): void {
  if (alpha <= 0.002) return
  const i = Math.max(0, Math.min(0.97, inner))
  ctx.save()
  ctx.translate(w / 2, h / 2)
  ctx.scale(w / 2, h / 2)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1.25)
  g.addColorStop(0, rgba(rgb, 0))
  g.addColorStop(i, rgba(rgb, 0))
  g.addColorStop(lerp(i, 1, 0.5), rgba(rgb, alpha * 0.32))
  g.addColorStop(lerp(i, 1, 0.8), rgba(rgb, alpha * 0.72))
  g.addColorStop(1, rgba(rgb, alpha))
  ctx.fillStyle = g
  ctx.fillRect(-1, -1, 2, 2)
  ctx.restore()
}

/** A band along all four edges, `depth` px deep, fading inward. Corners double up. */
export function edgeBand(ctx: CanvasRenderingContext2D, w: number, h: number, rgb: string, alpha: number, depth: number): void {
  if (alpha <= 0.002 || depth <= 0.5) return
  const band = (x0: number, y0: number, x1: number, y1: number, rx: number, ry: number, rw: number, rh: number) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1)
    g.addColorStop(0, rgba(rgb, alpha))
    g.addColorStop(0.35, rgba(rgb, alpha * 0.45))
    g.addColorStop(1, rgba(rgb, 0))
    ctx.fillStyle = g
    ctx.fillRect(rx, ry, rw, rh)
  }
  ctx.save()
  band(0, 0, 0, depth, 0, 0, w, depth)
  band(0, h, 0, h - depth, 0, h - depth, w, depth)
  band(0, 0, depth, 0, 0, 0, depth, h)
  band(w, 0, w - depth, 0, w - depth, 0, depth, h)
  ctx.restore()
}

/** Bounded cache for geometry keyed by seed and size. */
const store = new Map<string, unknown>()
export function memo<T>(key: string, make: () => T, limit = 12): T {
  const hit = store.get(key)
  if (hit !== undefined) return hit as T
  const value = make()
  while (store.size >= limit) store.delete(store.keys().next().value as string)
  store.set(key, value)
  return value
}

/** Device pixels per CSS pixel the frame is drawn at. */
export function frameScale(ctx: CanvasRenderingContext2D): number {
  const s = ctx.getTransform().a
  return s > 0 && Number.isFinite(s) ? s : 1
}
