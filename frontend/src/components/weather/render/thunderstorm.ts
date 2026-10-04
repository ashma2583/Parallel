/**
 * Thunderstorm: a radar reflectivity cell (a bow echo for a derecho) with rain,
 * a gust front ahead of it and in-cloud lightning. Leaves a wet sheen behind.
 */
import { cached, frac, resample, rgba, sampleAt, strokeBolt, TAU, traceLoop } from './a-shared'
import type { CellArgs, Frame, KindRenderer, Pt, TrackArgs } from './types'
import { boltPoints, noise1, noise2, pathLengthPx, rng } from './util'

/** Radar ramp, outer shield to core: scale, forward shift, ragged amplitude, alpha. */
interface Band {
  rgb: [string, string]
  scale: number
  shift: number
  rough: number
  alpha: [number, number]
  /** Bow echo: lateral reach and front / back thickness, in cell units. */
  span: number
  front: number
  back: number
}

const BANDS: Band[] = [
  { rgb: ['70,205,200', '20,150,150'], scale: 1.12, shift: -0.1, rough: 0.2, alpha: [0.1, 0.12], span: 1.15, front: 0.45, back: 1.55 },
  { rgb: ['70,200,95', '30,160,70'], scale: 0.88, shift: -0.03, rough: 0.22, alpha: [0.13, 0.15], span: 1.0, front: 0.28, back: 0.95 },
  { rgb: ['245,225,70', '225,190,20'], scale: 0.62, shift: 0.06, rough: 0.26, alpha: [0.2, 0.24], span: 0.86, front: 0.17, back: 0.45 },
  { rgb: ['255,145,45', '245,120,20'], scale: 0.42, shift: 0.13, rough: 0.28, alpha: [0.28, 0.3], span: 0.68, front: 0.1, back: 0.2 },
  { rgb: ['240,50,60', '220,30,45'], scale: 0.26, shift: 0.18, rough: 0.3, alpha: [0.36, 0.38], span: 0.5, front: 0.065, back: 0.11 },
  { rgb: ['235,80,215', '200,40,180'], scale: 0.13, shift: 0.21, rough: 0.32, alpha: [0.5, 0.5], span: 0.3, front: 0.04, back: 0.05 },
]

interface Satellite {
  x: number
  y: number
  scale: number
  depth: number
  seed: number
}

interface Drop {
  x: number
  y: number
  speed: number
  len: number
}

interface Twig {
  u: number
  off: number
  angle: number
  len: number
  fork: number
}

function cellData(seed: number, level: number) {
  return cached(`storm:cell:${seed}:${level}`, () => {
    const r = rng(seed ^ 0x7a11)
    const sats: Satellite[] = []
    const count = level === 2 ? 2 : 2 + Math.floor(r() * 2)
    for (let i = 0; i < count; i++) {
      const side = i % 2 === 0 ? 1 : -1
      sats.push({
        x: (r() - 0.6) * 0.5,
        y: side * (0.55 + r() * 0.4) * (level === 2 ? 1.25 : 1),
        scale: 0.32 + r() * 0.18,
        depth: 2 + Math.floor(r() * 2.5),
        seed: Math.floor(r() * 1e6),
      })
    }
    const drops: Drop[] = []
    for (let i = 0; i < 110 + level * 45; i++) drops.push({ x: r() * 2 - 1, y: r() * 2 - 1, speed: 0.5 + r() * 0.6, len: 0.6 + r() * 0.8 })
    const cores: Satellite[] = []
    for (let i = 0; i < 3; i++) cores.push({ x: (r() - 0.3) * 0.5, y: (r() * 2 - 1) * 0.55, scale: 0.5 + r() * 0.3, depth: 3 + Math.floor(r() * 2.5), seed: Math.floor(r() * 1e6) })
    return { sats, drops, cores, tilt: r() * TAU }
  })
}

function twigs(seed: number) {
  return cached(`storm:twigs:${seed}`, () => {
    const r = rng(seed ^ 0x3c9)
    const out: Twig[] = []
    for (let i = 0; i < 180; i++) out.push({ u: r(), off: (r() * 2 - 1) * 0.85, angle: r() * TAU, len: 2.5 + r() * 4, fork: r() })
    return out
  })
}

/** Ragged ellipse for one radar band, in the cell's local frame (x forward, y across). */
function blob(path: Path2D, ox: number, oy: number, A: number, B: number, band: Band, k: number, t: number, seed: number, scale = 1) {
  const n = k < 2 ? 72 : 44
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < n; i++) {
    const th = (i / n) * TAU
    const c = Math.cos(th)
    const s = Math.sin(th)
    const m =
      1 +
      band.rough *
        ((noise2(c * 1.4 + k * 0.7, s * 1.4 + t * 0.1, seed + k) - 0.5) * 2 +
          (noise2(c * 3.3 - t * 0.15, s * 3.3, seed + k * 7) - 0.5) * 1.1 +
          (noise2(c * 7.5, s * 7.5 + t * 0.25, seed + k * 13) - 0.5) * 0.55)
    let x = c * B * band.scale * scale
    if (x < 0) x *= 1.25
    xs.push(ox + x * m + band.shift * B * scale)
    ys.push(oy + s * A * band.scale * scale * m)
  }
  traceLoop(path, xs, ys)
}

/** One band of a bow echo: an arc bulging forward, cores hugging the leading edge. */
function bow(path: Path2D, A: number, B: number, band: Band, k: number, t: number, seed: number) {
  const m = 40
  const xs: number[] = []
  const ys: number[] = []
  const reach = band.span * A
  const centre = (v: number) => B * 0.7 * (1 - (v / A) * (v / A)) - B * 0.3
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j <= m; j++) {
      const u = pass === 0 ? j / m : 1 - j / m
      const v = (u * 2 - 1) * reach
      const g = Math.pow(Math.max(0, 1 - (v / reach) * (v / reach)), 0.55)
      const n =
        1 +
        band.rough *
          ((noise2((v / A) * 2.2 + pass * 9, t * 0.12 + k, seed + k) - 0.5) * 2.2 + (noise2((v / A) * 7 + pass * 5, t * 0.2 + k * 3, seed + k * 5) - 0.5) * 1.2)
      let thick = (pass === 0 ? band.front : band.back) * B * g * n
      if (pass === 1 && k <= 1) thick *= 1 - 0.5 * Math.exp(-((v / (A * 0.22)) ** 2))
      xs.push(centre(v) + (pass === 0 ? thick : -thick) + (k > 2 ? B * 0.04 : 0))
      ys.push(v)
    }
  }
  traceLoop(path, xs, ys)
}

function track(f: Frame, a: TrackArgs) {
  const { ctx, dark } = f
  const r = a.radiusPx
  if (r < 1 || a.swept.length === 0) return
  const sheen = dark ? '110,185,220' : '40,105,150'
  const gloss = dark ? '200,235,255' : '30,85,130'
  const twig = dark ? '150,170,120' : '74,88,50'
  const all = twigs(a.seed)
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (a.swept.length === 1 || pathLengthPx(a.swept) < 1) {
    const p = a.swept[0]
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r)
    g.addColorStop(0, rgba(sheen, 0.16))
    g.addColorStop(0.7, rgba(sheen, 0.08))
    g.addColorStop(1, rgba(sheen, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, TAU)
    ctx.fill()
    const path = new Path2D()
    for (let i = 0; i < 40; i++) {
      const tw = all[i]
      const rad = Math.sqrt(tw.u) * r * 0.85
      drawTwig(path, p.x + Math.cos(tw.off * 4) * rad, p.y + Math.sin(tw.off * 4) * rad, tw)
    }
    ctx.lineWidth = 1.1
    ctx.strokeStyle = rgba(twig, 0.6)
    ctx.stroke(path)
    ctx.restore()
    return
  }

  const line = resample(a.swept, Math.max(3, r / 24))
  const swept = line[line.length - 1].s
  const full = Math.max(swept, pathLengthPx(a.path))
  const head = line[line.length - 1]
  const tail = a.live ? sampleAt(line, Math.max(0, swept - r * 6)) : line[0]
  const grad = (rgb: string, near: number, far: number) => {
    const g = ctx.createLinearGradient(head.x, head.y, tail.x + (tail.x === head.x && tail.y === head.y ? 1 : 0), tail.y)
    g.addColorStop(0, rgba(rgb, near))
    g.addColorStop(1, rgba(rgb, far))
    return g
  }
  const near = a.live ? 1 : 0.8
  const far = a.live ? 0.015 : 0.035
  const trace = () => {
    ctx.beginPath()
    line.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
  }
  const widths = [1.0, 0.82, 0.62]
  const alphas = dark ? [0.07, 0.07, 0.09] : [0.08, 0.09, 0.11]
  for (let i = 0; i < widths.length; i++) {
    trace()
    ctx.lineWidth = r * 2 * widths[i]
    ctx.strokeStyle = grad(sheen, alphas[i] * near, far)
    ctx.stroke()
  }

  // Glossy streaks, like light on wet pavement.
  const rnd = rng(a.seed ^ 0x5eed)
  for (let j = 0; j < 7; j++) {
    const off = (rnd() * 2 - 1) * 0.75 * r
    const dash = [r * (0.3 + rnd() * 0.9), r * (0.15 + rnd() * 0.5), r * (0.1 + rnd() * 0.4), r * (0.2 + rnd() * 0.6)]
    ctx.beginPath()
    for (let i = 0; i < line.length; i++) {
      const p = line[i]
      const x = p.x + p.nx * off
      const y = p.y + p.ny * off
      if (i) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    }
    ctx.setLineDash(dash)
    ctx.lineDashOffset = rnd() * r
    ctx.lineWidth = 1 + rnd() * 1.6
    ctx.strokeStyle = grad(gloss, (dark ? 0.2 : 0.16) * near, 0.02)
    ctx.stroke()
  }
  ctx.setLineDash([])

  // Torn branches across the track.
  const want = Math.min(all.length, Math.round((full / r) * 14))
  const path = new Path2D()
  for (let i = 0; i < want; i++) {
    const tw = all[i]
    const s = tw.u * full
    if (s > swept) continue
    const p = sampleAt(line, s)
    drawTwig(path, p.x + p.nx * tw.off * r, p.y + p.ny * tw.off * r, tw)
  }
  ctx.lineWidth = 1.1
  ctx.strokeStyle = rgba(twig, dark ? 0.55 : 0.6)
  ctx.stroke(path)
  ctx.restore()
}

function drawTwig(path: Path2D, x: number, y: number, tw: Twig) {
  const c = Math.cos(tw.angle)
  const s = Math.sin(tw.angle)
  const l = tw.len
  path.moveTo(x - c * l, y - s * l)
  path.lineTo(x + c * l, y + s * l)
  const fx = x + c * l * (tw.fork - 0.5)
  const fy = y + s * l * (tw.fork - 0.5)
  const fa = tw.angle + (tw.fork > 0.5 ? 0.7 : -0.7)
  path.moveTo(fx, fy)
  path.lineTo(fx + Math.cos(fa) * l * 0.6, fy + Math.sin(fa) * l * 0.6)
}

function cell(f: Frame, a: CellArgs) {
  const { ctx, dark } = f
  const r = a.radiusPx
  const k = a.intensity
  if (r < 2 || k <= 0) return
  const lv = Math.max(0, Math.min(2, a.level))
  const t = f.now / 1000
  const seed = a.seed
  const theme = dark ? 0 : 1
  const { sats, drops, cores, tilt } = cellData(seed, lv)
  const derecho = lv === 2
  const heading = a.stationary ? tilt : a.heading
  const A = r * (a.stationary ? 0.95 : derecho ? 1.05 : 1)
  const B = r * (a.stationary ? 0.8 : derecho ? 0.55 : 0.62)
  const cx = a.head.x
  const cy = a.head.y

  // Lightning: one chance per slot, seeded by the slot so it is stable within it.
  const slotMs = 640 - lv * 90
  const clock = f.now + (seed % 9973)
  const slot = Math.floor(clock / slotMs)
  const sr = rng((seed ^ Math.imul(slot, 0x9e3779b1)) >>> 0)
  const fires = sr() < 0.62 + lv * 0.12
  const at = sr() * slotMs * 0.6
  const dt = clock - slot * slotMs - at
  let flash = 0
  if (fires && dt >= 0 && dt < 260) flash = dt < 45 ? 1 : dt < 80 ? 0.25 : dt < 130 ? 0.85 : (260 - dt) / 130 * 0.5

  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(heading)

  for (let b = 0; b < BANDS.length; b++) {
    const band = BANDS[b]
    const path = new Path2D()
    if (derecho) {
      bow(path, A, B, band, b, t, seed)
      if (b >= 2) {
        for (const c of cores) {
          if (b > c.depth) continue
          const v = c.y * A * 1.2
          blob(path, B * 0.7 * (1 - (v / A) ** 2) - B * 0.28, v, A * 0.55, B * 0.5, band, b, t + c.seed, c.seed, c.scale)
        }
      }
    } else {
      blob(path, 0, 0, A, B, band, b, t, seed)
      if (b >= 2) for (const c of cores) if (b <= c.depth) blob(path, c.x * B, c.y * A, A, B, band, b, t + c.seed, c.seed, c.scale)
    }
    for (const s of sats) if (b <= s.depth) blob(path, s.x * B, s.y * A, A, B, band, b, t + s.seed, s.seed, s.scale)
    ctx.fillStyle = rgba(band.rgb[theme], band.alpha[theme] * k * (1 + flash * 0.25))
    ctx.fill(path)
    if (b >= 1) {
      ctx.lineWidth = 0.8
      ctx.strokeStyle = rgba(band.rgb[theme], (dark ? 0.35 : 0.45) * k)
      ctx.stroke(path)
    }
  }

  // Rain, driven forward by the outflow.
  const rain = new Path2D()
  const streak = Math.max(4, Math.min(11, r * 0.03))
  for (const d of drops) {
    const x = frac(d.x * 0.5 + 0.5 + t * d.speed * 0.9) * 2 - 1
    const y = d.y
    const e = x * x + y * y
    if (e > 0.8) continue
    const X = x * B * (derecho ? 0.9 : 1) + (derecho ? B * 0.7 * (1 - y * y) - B * 0.55 : 0)
    const Y = y * A * 0.9
    rain.moveTo(X, Y)
    rain.lineTo(X + streak * d.len, Y + streak * d.len * 0.22)
  }
  ctx.lineCap = 'round'
  ctx.lineWidth = 0.9
  ctx.strokeStyle = dark ? rgba('210,232,255', 0.4 * k) : rgba('30,60,110', 0.34 * k)
  ctx.stroke(rain)

  // Gust front: a thin bright outflow boundary running ahead of the cell.
  const gust = new Path2D()
  const pulse = 0.5 + 0.5 * Math.sin(t * 2.2 + seed)
  if (a.stationary) {
    // Outflow pushing out from a storm that stays put: broken rings expanding.
    for (let ring = 0; ring < 2; ring++) {
      const ph = frac(t / 3.2 + ring * 0.5)
      const rad = r * (0.95 + ph * 0.38)
      let open = false
      for (let i = 0; i <= 72; i++) {
        const th = (i / 72) * TAU
        const on = noise1(i * 0.22 + ring * 40, seed + ring) > 0.36
        const rr = rad * (1 + 0.05 * (noise1(i * 0.4 + t * 0.6, seed) - 0.5))
        const x = Math.cos(th) * rr * (B / A + 0.15)
        const y = Math.sin(th) * rr
        if (on && open) gust.lineTo(x, y)
        else if (on) gust.moveTo(x, y)
        open = on
      }
    }
  } else {
    const lead = derecho ? B * 0.75 : B * 1.2
    for (let i = 0; i <= 40; i++) {
      const v = (i / 40) * 2 - 1
      const y = v * A * (derecho ? 1.05 : 0.85)
      const x = (derecho ? B * 0.7 * (1 - v * v) - B * 0.3 + lead * 0.55 : lead * Math.sqrt(Math.max(0, 1 - v * v * 0.7))) + B * 0.05 * pulse + (noise1(i * 0.35 + t * 0.5, seed) - 0.5) * B * 0.08
      if (i) gust.lineTo(x, y)
      else gust.moveTo(x, y)
    }
  }
  ctx.lineJoin = 'round'
  ctx.setLineDash([])
  ctx.lineWidth = 5
  ctx.strokeStyle = dark ? rgba('120,230,255', 0.1 * k) : rgba('0,110,140', 0.1 * k)
  ctx.stroke(gust)
  ctx.save()
  ctx.shadowColor = dark ? 'rgba(130,235,255,0.9)' : 'rgba(0,120,150,0.5)'
  ctx.shadowBlur = 6
  ctx.lineWidth = 1.3
  ctx.strokeStyle = dark ? rgba('205,250,255', 0.8 * k) : rgba('0,105,135', 0.75 * k)
  ctx.stroke(gust)
  ctx.restore()

  // In-cloud lightning and the cell lighting up around it.
  if (flash > 0) {
    const br = rng((seed ^ Math.imul(slot, 0x85ebca6b)) >>> 0)
    const bx = derecho ? B * 0.1 : B * 0.15
    const p0 = { x: bx + (br() - 0.5) * B * 0.6, y: (br() - 0.5) * A * (derecho ? 1.1 : 0.7) }
    const ang = br() * TAU
    const len = r * (0.45 + br() * 0.4)
    const p1 = { x: p0.x + Math.cos(ang) * len, y: p0.y + Math.sin(ang) * len * 1.2 }
    const main = boltPoints(p0, p1, br, 0.3, 5)
    const forks: Pt[][] = []
    for (let i = 0; i < 3 + lv; i++) {
      const from = main[Math.floor(br() * (main.length - 4)) + 2]
      const fa = ang + (br() - 0.5) * 2.2
      const fl = len * (0.2 + br() * 0.35)
      forks.push(boltPoints(from, { x: from.x + Math.cos(fa) * fl, y: from.y + Math.sin(fa) * fl }, br, 0.35, 4))
    }
    const glow = ctx.createRadialGradient(p0.x, p0.y, 0, p0.x, p0.y, r * 0.9)
    glow.addColorStop(0, rgba(dark ? '210,225,255' : '255,255,255', 0.35 * flash * k))
    glow.addColorStop(1, rgba(dark ? '210,225,255' : '255,255,255', 0))
    ctx.save()
    if (dark) ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(p0.x, p0.y, r * 0.9, 0, TAU)
    ctx.fill()
    ctx.restore()
    strokeBolt(ctx, main, forks, dark, flash * k, Math.max(0.7, Math.min(1.3, r / 220)))
  }
  ctx.restore()
}

export const thunderstorm: KindRenderer = { track, cell }
