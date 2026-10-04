/** Flat-earth geometry for a few kilometers of Ann Arbor. Meters, not degrees. */
import type { LngLat } from './types'

const LAT0 = 42.28
const MX = Math.cos((LAT0 * Math.PI) / 180) * 111_320
const MY = 110_540

export function toXY(p: LngLat): [number, number] {
  return [p[0] * MX, p[1] * MY]
}

export function fromXY(x: number, y: number): LngLat {
  return [x / MX, y / MY]
}

export function dist(a: LngLat, b: LngLat): number {
  return Math.hypot((a[0] - b[0]) * MX, (a[1] - b[1]) * MY)
}

export function distPointSeg(p: LngLat, a: LngLat, b: LngLat): number {
  const [px, py] = toXY(p)
  const [ax, ay] = toXY(a)
  const [bx, by] = toXY(b)
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

export function distPointPath(p: LngLat, path: readonly LngLat[]): number {
  if (path.length === 0) return Infinity
  if (path.length === 1) return dist(p, path[0])
  let best = Infinity
  for (let i = 1; i < path.length; i++) best = Math.min(best, distPointSeg(p, path[i - 1], path[i]))
  return best
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

export function distSegSeg(a: LngLat, b: LngLat, c: LngLat, d: LngLat): number {
  const [ax, ay] = toXY(a)
  const [bx, by] = toXY(b)
  const [cx, cy] = toXY(c)
  const [dx, dy] = toXY(d)
  const d1 = cross(cx, cy, dx, dy, ax, ay)
  const d2 = cross(cx, cy, dx, dy, bx, by)
  const d3 = cross(ax, ay, bx, by, cx, cy)
  const d4 = cross(ax, ay, bx, by, dx, dy)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0
  return Math.min(distPointSeg(a, c, d), distPointSeg(b, c, d), distPointSeg(c, a, b), distPointSeg(d, a, b))
}

/** Running length at each vertex. */
export function cumulative(path: readonly LngLat[]): number[] {
  const out = [0]
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + dist(path[i - 1], path[i]))
  return out
}

export function pathLength(path: readonly LngLat[]): number {
  const c = cumulative(path)
  return c[c.length - 1]
}

/** The point `s` meters along the path. */
export function pointAt(path: readonly LngLat[], s: number, cum = cumulative(path)): LngLat {
  if (path.length === 1 || s <= 0) return path[0]
  const total = cum[cum.length - 1]
  if (s >= total) return path[path.length - 1]
  let i = 1
  while (i < cum.length - 1 && cum[i] < s) i++
  const span = cum[i] - cum[i - 1]
  const f = span === 0 ? 0 : (s - cum[i - 1]) / span
  const a = path[i - 1]
  const b = path[i]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
}

/** The path up to `s` meters, ending exactly at that point. */
export function slicePath(path: readonly LngLat[], s: number, cum = cumulative(path)): LngLat[] {
  if (path.length < 2) return [...path]
  const out: LngLat[] = [path[0]]
  for (let i = 1; i < path.length && cum[i] < s; i++) out.push(path[i])
  out.push(pointAt(path, s, cum))
  return out
}

/** Compass bearing from a to b, radians clockwise from north. */
export function bearing(a: LngLat, b: LngLat): number {
  const [ax, ay] = toXY(a)
  const [bx, by] = toXY(b)
  return Math.atan2(bx - ax, by - ay)
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']

export function compass(rad: number): string {
  const i = Math.round(((rad * 180) / Math.PI + 360) / 45) % 8
  return COMPASS[i]
}

/** Douglas-Peucker in meters. Keeps the first and last points. */
export function simplify(path: readonly LngLat[], tolerance: number): LngLat[] {
  if (path.length <= 2) return [...path]
  let worst = 0
  let index = 0
  for (let i = 1; i < path.length - 1; i++) {
    const d = distPointSeg(path[i], path[0], path[path.length - 1])
    if (d > worst) {
      worst = d
      index = i
    }
  }
  if (worst <= tolerance) return [path[0], path[path.length - 1]]
  const left = simplify(path.slice(0, index + 1), tolerance)
  const right = simplify(path.slice(index), tolerance)
  return [...left.slice(0, -1), ...right]
}

// ---------------------------------------------------------------------------
// The run clock. Impacts and the canvas both use these, so a hit lands exactly
// when the drawn storm reaches it.
// ---------------------------------------------------------------------------

/** A moving storm spends this much of its run touching down, and the same dissipating. */
export const TOUCHDOWN = 0.06

/** How far along its track the storm centre is at a given run progress (0..1). */
export function headFraction(progress: number): number {
  return Math.max(0, Math.min(1, (progress - TOUCHDOWN) / (1 - 2 * TOUCHDOWN)))
}

/** The run progress at which the centre reaches a fraction of the track. */
export function progressAtFraction(fraction: number): number {
  return TOUCHDOWN + fraction * (1 - 2 * TOUCHDOWN)
}

/** A storm dropped in one place grows to full size over this share of its run. */
export const GROW = 0.5

/** Footprint radius at a run progress, for a storm that stays in place. */
export function growRadius(radius: number, progress: number): number {
  const f = Math.max(0, Math.min(1, progress / GROW))
  return radius * (1 - (1 - f) * (1 - f))
}

/** The run progress at which a growing storm's edge reaches `d` meters. Inverse of growRadius. */
export function progressAtReach(d: number, radius: number): number {
  const f = Math.max(0, Math.min(1, d / radius))
  return Math.max(0.03, GROW * (1 - Math.sqrt(1 - f)))
}

/** Lightning lands at this point in its run. */
export const STRIKE = 0.3

export function runDuration(kind: string, path: readonly LngLat[], msPerKm: number): number {
  if (kind === 'lightning') return 1800
  if (path.length < 2) return 3600
  const km = pathLength(path) / 1000
  return Math.max(2600, Math.min(9000, 1200 + km * msPerKm))
}

/**
 * First run progress at which a moving footprint of `radius` meters comes
 * within reach of something. `gap(center)` is the distance from the storm
 * centre to that thing. Null when the storm never reaches it.
 */
export function firstContact(
  path: readonly LngLat[],
  radius: number,
  gap: (center: LngLat) => number,
): number | null {
  if (path.length === 1) {
    const d = gap(path[0])
    return d <= radius ? progressAtReach(d, radius) : null
  }
  const cum = cumulative(path)
  const total = cum[cum.length - 1]
  const steps = Math.max(2, Math.ceil(total / 10))
  for (let i = 0; i <= steps; i++) {
    const s = (total * i) / steps
    if (gap(pointAt(path, s, cum)) <= radius) return progressAtFraction(total === 0 ? 0 : s / total)
  }
  return null
}

/**
 * Split a line into the parts still running and the parts closed. A vertex is
 * closed when it is within `tolerance` meters of any closed stretch. Each closed
 * part keeps one running vertex at each end so the dashes meet the solid line.
 */
export function splitByClosures(
  coords: readonly LngLat[],
  closed: readonly (readonly LngLat[])[],
  tolerance = 30,
): { open: LngLat[][]; shut: LngLat[][] } {
  if (closed.length === 0) return { open: [[...coords]], shut: [] }
  const flags = coords.map((p) => closed.some((segment) => distPointPath(p, segment) <= tolerance))
  const open: LngLat[][] = []
  const shut: LngLat[][] = []
  let i = 0
  while (i < coords.length) {
    let j = i
    while (j + 1 < coords.length && flags[j + 1] === flags[i]) j++
    if (flags[i]) {
      const part = coords.slice(Math.max(0, i - 1), Math.min(coords.length, j + 2))
      if (part.length >= 2) shut.push(part)
    } else {
      const part = coords.slice(i, j + 1)
      if (part.length >= 2) open.push(part)
    }
    i = j + 1
  }
  return { open, shut }
}
