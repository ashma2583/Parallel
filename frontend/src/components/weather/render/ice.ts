/**
 * Ice storm: a pale freezing-rain cell with driven sleet, sparkling crystals
 * and frost ferns on its rim, leaving a cracked, glinting glaze behind it.
 */
import {
  blob,
  cached,
  clamp,
  distToPath,
  fillBlob,
  frac,
  gridSites,
  hash2,
  lru,
  noisyLoop,
  ptsKey,
  rgba,
  siteAt,
  type Site,
  star,
  TAU,
  traceBlob,
  traceRuns,
  twinkle,
  unitPx,
} from './b-shared'
import type { KindRenderer, Pt } from './types'
import { rng } from './util'

interface Palette {
  glaze: string
  facet: string
  crack: string
  rim: string
  body: string
  core: string
  sleet: string
  fern: string
  spark: string
  halo: string
  glint: string
  base: number
}

const DARK: Palette = {
  glaze: '186,230,253',
  facet: '186,230,253',
  crack: '240,249,255',
  rim: '224,242,254',
  body: '186,230,253',
  core: '125,211,252',
  sleet: '224,242,254',
  fern: '224,242,254',
  spark: '255,255,255',
  halo: '125,211,252',
  glint: '255,255,255',
  base: 0.1,
}

const LIGHT: Palette = {
  glaze: '56,189,248',
  facet: '255,255,255',
  crack: '3,105,161',
  rim: '2,132,199',
  body: '56,189,248',
  core: '14,165,233',
  sleet: '12,74,110',
  fern: '3,105,161',
  spark: '255,255,255',
  halo: '2,132,199',
  glint: '255,255,255',
  base: 0.1,
}

// ---------------------------------------------------------------------------
// Glaze facets: Voronoi cells of a jittered grid, in grid units around each site.
// ---------------------------------------------------------------------------

const cells = new Map<string, Float32Array>()

function voronoi(i: number, j: number, seed: number): Float32Array {
  const key = `${i},${j},${seed}`
  const hit = cells.get(key)
  if (hit) return hit
  const [sx, sy] = siteAt(i, j, seed)
  let poly: number[] = [-2, -2, 2, -2, 2, 2, -2, 2]
  for (let di = -2; di <= 2; di++) {
    for (let dj = -2; dj <= 2; dj++) {
      if (di === 0 && dj === 0) continue
      const [nx, ny] = siteAt(i + di, j + dj, seed)
      const ox = nx - sx
      const oy = ny - sy
      poly = clipHalf(poly, ox, oy, (ox * ox + oy * oy) / 2)
      if (poly.length < 6) break
    }
  }
  const out = Float32Array.from(poly)
  if (cells.size > 40000) cells.clear()
  cells.set(key, out)
  return out
}

/** Keep the part of a polygon where p . n <= c. */
function clipHalf(poly: number[], nx: number, ny: number, c: number): number[] {
  const out: number[] = []
  const n = poly.length / 2
  for (let k = 0; k < n; k++) {
    const ax = poly[k * 2]
    const ay = poly[k * 2 + 1]
    const bx = poly[((k + 1) % n) * 2]
    const by = poly[((k + 1) % n) * 2 + 1]
    const da = ax * nx + ay * ny - c
    const db = bx * nx + by * ny - c
    if (da <= 0) out.push(ax, ay)
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db)
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Cell decorations, generated once per seed in unit-radius space.
// ---------------------------------------------------------------------------

interface Streak {
  u: number
  v: number
  len: number
  speed: number
  group: number
}

interface Sparkle {
  x: number
  y: number
  size: number
  rate: number
  phase: number
}

interface Fern {
  /** x1 y1 x2 y2 order, repeated. */
  segs: Float32Array
  reach: number
  phase: number
}

function sleet(seed: number): Streak[] {
  return cached(`ice-sleet-${seed}`, () => {
    const r = rng(seed ^ 0x51ee7)
    return Array.from({ length: 260 }, () => ({
      u: r() * 2 - 1,
      v: r() * 2 - 1,
      len: 0.6 + r() * 0.9,
      speed: 0.75 + r() * 0.5,
      group: Math.floor(r() * 3),
    }))
  })
}

function sparkles(seed: number): Sparkle[] {
  return cached(`ice-spark-${seed}`, () => {
    const r = rng(seed ^ 0x5a4c)
    return Array.from({ length: 34 }, () => {
      const rho = Math.sqrt(r()) * 0.92
      const th = r() * TAU
      return { x: Math.cos(th) * rho, y: Math.sin(th) * rho, size: 0.6 + r() * 0.8, rate: 1.4 + r() * 2.2, phase: r() * TAU }
    })
  })
}

function ferns(seed: number): Fern[] {
  return cached(`ice-fern-${seed}`, () => {
    const r = rng(seed ^ 0xfe12)
    const count = 16
    return Array.from({ length: count }, (_, i) => {
      const at = ((i + r() * 0.6) / count) * TAU
      const root = 0.985
      const segs: number[] = []
      const grow = (x: number, y: number, ang: number, len: number, depth: number, order: number) => {
        const steps = depth === 0 ? 2 : depth === 1 ? 4 : 6
        const bend = (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.6)
        let px = x
        let py = y
        let a = ang
        for (let s = 0; s < steps; s++) {
          const l = len / steps
          const nx = px + Math.cos(a) * l
          const ny = py + Math.sin(a) * l
          const o = order + ((s + 1) / steps) * len
          segs.push(px, py, nx, ny, o)
          if (depth > 0 && s >= 1 && s < steps - 1) {
            const side = s % 2 === 0 ? 1 : -1
            const sub = len * (depth === 2 ? 0.45 : 0.5) * (1 - (s / steps) * 0.55)
            grow(nx, ny, a + side * (0.6 + r() * 0.25), sub, depth - 1, o)
            if (depth === 2) grow(nx, ny, a - side * (0.6 + r() * 0.25), sub * 0.85, depth - 1, o)
          }
          px = nx
          py = ny
          a += bend / steps
        }
      }
      const tilt = (r() - 0.5) * 1.6
      const len = 0.14 + r() * 0.12
      grow(Math.cos(at) * root, Math.sin(at) * root, at + Math.PI + tilt, len, 2, 0)
      let reach = 0
      for (let k = 4; k < segs.length; k += 5) reach = Math.max(reach, segs[k])
      return { segs: Float32Array.from(segs), reach, phase: r() }
    })
  })
}

interface Glaze {
  tiles: Path2D[]
  cracks: Path2D
  faults: Path2D
  sparks: Site[]
}

/** Voronoi glaze for a whole track, built once per view. */
function facets(pts: readonly Pt[], reach: number, cell: number, origin: Pt, seed: number, view: { w: number; h: number }): Glaze {
  const key = `ice|${seed}|${reach.toFixed(1)}|${cell.toFixed(2)}|${origin.x.toFixed(1)},${origin.y.toFixed(1)}|${view.w}x${view.h}|${ptsKey(pts)}`
  return lru(key, () => {
    const tiles = [new Path2D(), new Path2D(), new Path2D()]
    const cracks = new Path2D()
    const faults = new Path2D()
    const sparks: Site[] = []
    for (const s of gridSites(pts, reach, cell, origin, seed, view)) {
      const poly = voronoi(s.i, s.j, seed)
      const n = poly.length / 2
      if (n < 3) continue
      const tile = tiles[s.h > 0.8 ? 2 : s.h > 0.4 ? 1 : 0]
      const [ox, oy] = siteAt(s.i, s.j, seed)
      const inset = 0.82
      for (let k = 0; k < n; k++) {
        const px = s.x + poly[k * 2] * cell * inset
        const py = s.y + poly[k * 2 + 1] * cell * inset
        if (k === 0) tile.moveTo(px, py)
        else tile.lineTo(px, py)
        // Each shared edge decides once, by its midpoint, whether it cracked.
        const k2 = (k + 1) % n
        const mx = poly[k * 2] + poly[k2 * 2]
        const my = poly[k * 2 + 1] + poly[k2 * 2 + 1]
        const eh = hash2(Math.round((ox * 2 + mx) * 256), Math.round((oy * 2 + my) * 256), seed + 9)
        if (eh > 0.6) continue
        const path = eh < 0.1 ? faults : cracks
        path.moveTo(s.x + poly[k * 2] * cell, s.y + poly[k * 2 + 1] * cell)
        path.lineTo(s.x + poly[k2 * 2] * cell, s.y + poly[k2 * 2 + 1] * cell)
      }
      tile.closePath()
      if (hash2(s.i, s.j, seed + 7) < 0.05) sparks.push(s)
    }
    return { tiles, cracks, faults, sparks }
  })
}

export const ice: KindRenderer = {
  track(f, a) {
    const r = a.radiusPx
    if (r < 2 || a.swept.length === 0) return
    const { ctx } = f
    const p = f.dark ? DARK : LIGHT
    const unit = unitPx(a.kind, a.level, f.pxPerMeter, r)
    const origin = a.path[0] ?? a.swept[0]
    const opts = { seed: a.seed, rough: 0.09, unit, origin }
    const shape = blob(a.swept, r, opts)
    const t = f.now / 1000

    ctx.save()
    fillBlob(ctx, blob(a.swept, r, { ...opts, scale: 1.08 }), rgba(p.glaze, p.base * 0.45))
    fillBlob(ctx, shape, rgba(p.glaze, p.base))

    ctx.beginPath()
    traceBlob(ctx, shape)
    ctx.clip()

    // Faceted glaze over the whole track, revealed by the clip as the storm sweeps on.
    const cell = clamp(unit * 0.085, 18, 52)
    const glaze = facets(a.path.length ? a.path : a.swept, unit * 1.12 + cell, cell, origin, a.seed, { w: f.width, h: f.height })
    const tint = f.dark ? [0.03, 0.065, 0.12] : [0.08, 0.17, 0.3]
    glaze.tiles.forEach((tile, i) => {
      ctx.fillStyle = rgba(p.facet, tint[i] * (0.7 + 0.3 * Math.sin(t * 0.7 + i * 2.1)))
      ctx.fill(tile)
    })
    ctx.lineCap = 'round'
    ctx.strokeStyle = rgba(p.crack, f.dark ? 0.2 : 0.2)
    ctx.lineWidth = 0.7
    ctx.stroke(glaze.cracks)
    ctx.strokeStyle = rgba(p.crack, f.dark ? 0.42 : 0.38)
    ctx.lineWidth = 1.1
    ctx.stroke(glaze.faults)

    // A slow glint sweeping across the ice.
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const q of a.swept) {
      minX = Math.min(minX, q.x - r)
      minY = Math.min(minY, q.y - r)
      maxX = Math.max(maxX, q.x + r)
      maxY = Math.max(maxY, q.y + r)
    }
    const band = frac(t / 7 + (a.seed % 97) / 97) * 1.6 - 0.3
    const L = Math.hypot(maxX - minX, maxY - minY) || 1
    const ux = (maxX - minX) / L
    const uy = (maxY - minY) / L
    const cx = minX + ux * L * band
    const cy = minY + uy * L * band
    const half = L * 0.12
    const g = ctx.createLinearGradient(cx - ux * half, cy - uy * half, cx + ux * half, cy + uy * half)
    g.addColorStop(0, rgba(p.glint, 0))
    g.addColorStop(0.4, rgba(p.glint, f.dark ? 0.07 : 0.22))
    g.addColorStop(0.5, rgba(p.glint, f.dark ? 0.13 : 0.34))
    g.addColorStop(0.6, rgba(p.glint, f.dark ? 0.07 : 0.22))
    g.addColorStop(1, rgba(p.glint, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(cx - ux * half - uy * L, cy - uy * half + ux * L)
    ctx.lineTo(cx + ux * half - uy * L, cy + uy * half + ux * L)
    ctx.lineTo(cx + ux * half + uy * L, cy + uy * half - ux * L)
    ctx.lineTo(cx - ux * half + uy * L, cy - uy * half - ux * L)
    ctx.closePath()
    ctx.fill()
    ctx.restore()

    // Cold bright rim.
    ctx.save()
    ctx.beginPath()
    traceRuns(ctx, shape.outline)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = rgba(p.halo, f.dark ? 0.12 : 0.12)
    ctx.lineWidth = 6
    ctx.stroke()
    ctx.strokeStyle = rgba(p.rim, f.dark ? 0.55 : 0.6)
    ctx.lineWidth = 1.2
    ctx.stroke()

    // Slow twinkles on the glaze.
    ctx.globalCompositeOperation = f.dark ? 'lighter' : 'source-over'
    const glow = new Path2D()
    const stars = new Path2D()
    let any = false
    for (const s of glaze.sparks) {
      const tw = twinkle(t, 0.9 + s.h * 1.4, s.h * 91)
      if (tw < 0.04 || (a.live && distToPath(s.x, s.y, a.swept) > r * 0.95)) continue
      const size = (3 + 6 * tw) * clamp(cell / 30, 0.7, 1.3)
      star(stars, s.x, s.y, size)
      glow.moveTo(s.x + size * 0.5, s.y)
      glow.arc(s.x, s.y, size * 0.5, 0, TAU)
      any = true
    }
    if (any) {
      ctx.fillStyle = rgba(p.halo, f.dark ? 0.35 : 0.3)
      ctx.fill(glow)
      ctx.fillStyle = rgba(p.spark, 0.9)
      ctx.fill(stars)
    }
    ctx.restore()
  },

  cell(f, a) {
    const r = a.radiusPx
    const k = a.intensity
    if (r < 2 || k <= 0.01) return
    const { ctx } = f
    const p = f.dark ? DARK : LIGHT
    const { x, y } = a.head
    const T = a.elapsed / 1000
    const now = f.now / 1000

    ctx.save()
    ctx.globalAlpha = k

    // Body: layered wobbling discs, denser toward the core.
    const layers: [number, number, number][] = f.dark
      ? [
          [1.14, 0.05, 0.12],
          [1.0, 0.1, 0.1],
          [0.8, 0.08, 0.08],
          [0.5, 0.07, 0.06],
        ]
      : [
          [1.14, 0.04, 0.12],
          [1.0, 0.08, 0.1],
          [0.8, 0.07, 0.08],
          [0.5, 0.06, 0.06],
        ]
    layers.forEach(([s, alpha, rough], i) => {
      ctx.beginPath()
      noisyLoop(ctx, x, y, r * s, rough, a.seed + i * 13, T * 0.12 + i)
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * s * 1.1)
      g.addColorStop(0, rgba(p.core, alpha * 1.2))
      g.addColorStop(0.7, rgba(p.body, alpha))
      g.addColorStop(1, rgba(p.body, alpha * 0.55))
      ctx.fillStyle = g
      ctx.fill()
    })

    // Drifting bands of heavier precipitation inside the cell.
    for (let i = 0; i < 5; i++) {
      const ang = a.seed * 0.37 + i * 1.9 + T * 0.18 * (i % 2 ? 1 : -1)
      const rho = r * (0.25 + 0.12 * i)
      const bx = x + Math.cos(ang) * rho
      const by = y + Math.sin(ang) * rho
      const br = r * (0.28 + 0.06 * (i % 3))
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, br)
      g.addColorStop(0, rgba(p.facet, f.dark ? 0.09 : 0.18))
      g.addColorStop(1, rgba(p.facet, 0))
      ctx.fillStyle = g
      ctx.fillRect(bx - br, by - br, br * 2, br * 2)
    }

    // Cold rim.
    ctx.beginPath()
    noisyLoop(ctx, x, y, r, 0.1, a.seed + 13, T * 0.12 + 1)
    ctx.lineJoin = 'round'
    ctx.strokeStyle = rgba(p.halo, 0.12)
    ctx.lineWidth = 7
    ctx.stroke()
    ctx.strokeStyle = rgba(p.rim, f.dark ? 0.5 : 0.55)
    ctx.lineWidth = 1.1
    ctx.stroke()

    // Driven sleet, clipped to the cell.
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, r * 0.97, 0, TAU)
    ctx.clip()
    const dir = 1.05 + Math.sin(a.heading) * 0.15
    const dx = Math.cos(dir)
    const dy = Math.sin(dir)
    const span = r * 2
    const streakLen = clamp(r * 0.05, 8, 24)
    const groups = [new Path2D(), new Path2D(), new Path2D()]
    for (const s of sleet(a.seed)) {
      const travel = T * 620 * s.speed
      const along = ((((s.u + 1) * r + travel) % span) + span) % span - r
      const across = s.v * r
      const px = x + dx * along - dy * across
      const py = y + dy * along + dx * across
      const l = streakLen * s.len
      groups[s.group].moveTo(px, py)
      groups[s.group].lineTo(px - dx * l, py - dy * l)
    }
    ctx.lineCap = 'round'
    ctx.lineWidth = 0.9
    ctx.globalCompositeOperation = f.dark ? 'lighter' : 'source-over'
    const sa = f.dark ? [0.2, 0.34, 0.55] : [0.14, 0.24, 0.36]
    groups.forEach((g, i) => {
      ctx.strokeStyle = rgba(p.sleet, sa[i])
      ctx.stroke(g)
    })
    ctx.restore()

    // Frost ferns creeping in from the rim.
    ctx.save()
    ctx.globalCompositeOperation = f.dark ? 'screen' : 'source-over'
    const fronds = new Path2D()
    for (const fern of ferns(a.seed)) {
      const cycle = frac(T / 6 + fern.phase)
      const grown = clamp(cycle / 0.5, 0, 1) * fern.reach
      if (cycle > 0.9) continue
      const s = fern.segs
      for (let q = 0; q < s.length; q += 5) {
        if (s[q + 4] > grown) continue
        fronds.moveTo(x + s[q] * r, y + s[q + 1] * r)
        fronds.lineTo(x + s[q + 2] * r, y + s[q + 3] * r)
      }
    }
    // Small cells on a zoomed-out map would turn the ferns into a scribble, so they fade out.
    const show = clamp((r - 60) / 120, 0, 1)
    ctx.lineCap = 'round'
    ctx.strokeStyle = rgba(p.halo, (f.dark ? 0.16 : 0.12) * show)
    ctx.lineWidth = clamp(r * 0.008, 1.5, 3.5)
    ctx.stroke(fronds)
    ctx.strokeStyle = rgba(p.fern, (f.dark ? 0.7 : 0.6) * show)
    ctx.lineWidth = clamp(r * 0.0025, 0.7, 1.3)
    ctx.stroke(fronds)
    ctx.restore()

    // Crystalline sparkles.
    ctx.globalCompositeOperation = f.dark ? 'lighter' : 'source-over'
    const glow = new Path2D()
    const stars = new Path2D()
    const scale = clamp(r / 120, 0.8, 1.6)
    for (const s of sparkles(a.seed)) {
      const tw = twinkle(now, s.rate, s.phase, 6)
      if (tw < 0.05) continue
      const sx = x + s.x * r
      const sy = y + s.y * r
      const size = (2 + 4.5 * tw) * s.size * scale
      star(stars, sx, sy, size)
      glow.moveTo(sx + size * 0.6, sy)
      glow.arc(sx, sy, size * 0.6, 0, TAU)
    }
    ctx.fillStyle = rgba(p.halo, f.dark ? 0.35 : 0.35)
    ctx.fill(glow)
    ctx.fillStyle = rgba(p.spark, 0.95)
    ctx.fill(stars)
    ctx.restore()
  },
}
