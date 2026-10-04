/**
 * Tornado: a violent top-down vortex with orbiting and flung debris, leaving a
 * ragged scoured scar with cycloidal suction marks behind it.
 */
import { cached, frac, resample, rgba, sampleAt, smoothstep, TAU, traceLoop, type Sample } from './a-shared'
import type { CellArgs, Frame, KindRenderer, TrackArgs } from './types'
import { noise1, pathLengthPx, rng } from './util'

interface Fleck {
  orbit: number
  phase: number
  size: number
  shade: number
  speed: number
}

interface Thrown {
  angle: number
  period: number
  offset: number
  size: number
  shade: number
  speed: number
}

interface Arm {
  angle: number
  reach: number
  width: number
  wind: number
}

interface Speck {
  u: number
  off: number
  size: number
  angle: number
  shade: number
}

function debris(seed: number, level: number) {
  return cached(`tornado:debris:${seed}:${level}`, () => {
    const r = rng(seed ^ 0x51ed)
    const flecks: Fleck[] = []
    for (let i = 0; i < 70 + level * 35; i++) {
      const orbit = 0.32 + Math.pow(r(), 0.7) * 0.95
      flecks.push({ orbit, phase: r() * TAU, size: 0.7 + r() * 1.9, shade: r(), speed: 0.75 + r() * 0.5 })
    }
    const thrown: Thrown[] = []
    for (let i = 0; i < 16 + level * 12; i++) {
      thrown.push({ angle: r() * TAU, period: 0.8 + r() * 0.9, offset: r(), size: 0.9 + r() * 1.8, shade: r(), speed: 0.7 + r() * 0.7 })
    }
    const arms: Arm[] = []
    const count = 5 + level
    for (let i = 0; i < count; i++) {
      arms.push({ angle: (i / count) * TAU + (r() - 0.5) * 0.6, reach: 1.0 + r() * 0.3, width: 0.7 + r() * 0.6, wind: 2.2 + r() * 0.9 + level * 0.25 })
    }
    return { flecks, thrown, arms }
  })
}

function specks(seed: number) {
  return cached(`tornado:specks:${seed}`, () => {
    const r = rng(seed ^ 0xbeef)
    const out: Speck[] = []
    for (let i = 0; i < 420; i++) {
      const g = (r() + r() + r() - 1.5) / 1.5
      out.push({ u: r(), off: g * 1.25, size: 0.8 + r() * 2.2, angle: r() * TAU, shade: r() })
    }
    return out.sort((a, b) => a.u - b.u)
  })
}

/** Ragged half-width of the scar at `s` px along the track, in units of the radius. */
function scarWidth(s: number, r: number, seed: number, base: number): number {
  const x = s / r
  return base * (0.78 + 0.42 * noise1(x * 0.9, seed) + 0.22 * noise1(x * 3.7, seed + 11) + 0.12 * noise1(x * 9, seed + 23))
}

function band(ctx: CanvasRenderingContext2D, line: Sample[], r: number, seed: number, base: number, taper: (s: number) => number) {
  ctx.beginPath()
  for (let i = 0; i < line.length; i++) {
    const p = line[i]
    const w = r * scarWidth(p.s, r, seed, base) * taper(p.s)
    if (i === 0) ctx.moveTo(p.x + p.nx * w, p.y + p.ny * w)
    else ctx.lineTo(p.x + p.nx * w, p.y + p.ny * w)
  }
  for (let i = line.length - 1; i >= 0; i--) {
    const p = line[i]
    const w = r * scarWidth(p.s, r, seed + 101, base) * taper(p.s)
    ctx.lineTo(p.x - p.nx * w, p.y - p.ny * w)
  }
  ctx.closePath()
}

function track(f: Frame, a: TrackArgs) {
  const { ctx, dark } = f
  const r = a.radiusPx
  if (r < 0.5 || a.swept.length === 0) return
  const line = resample(a.swept, Math.max(2, Math.min(6, r / 6)))
  const swept = line[line.length - 1].s
  const full = Math.max(swept, pathLengthPx(a.path))
  const taper = (s: number) => smoothstep(0, r * 1.6, s + r * 0.25) * (a.live ? 1 : smoothstep(0, r * 1.2, full - s + r * 0.2))
  const soil = dark ? '196,170,138' : '92,74,58'
  const deep = dark ? '28,22,18' : '52,40,32'
  const seed = a.seed

  ctx.save()
  if (line.length === 1) {
    ctx.beginPath()
    ctx.arc(line[0].x, line[0].y, r * 0.7, 0, TAU)
    ctx.fillStyle = rgba(soil, 0.2)
    ctx.fill()
    ctx.restore()
    return
  }

  // Outer spray of loose debris, then the scoured band, then the gouged centre.
  band(ctx, line, r, seed, 0.95, taper)
  ctx.fillStyle = rgba(soil, dark ? 0.12 : 0.11)
  ctx.fill()
  band(ctx, line, r, seed + 5, 0.62, taper)
  ctx.fillStyle = rgba(soil, dark ? 0.16 : 0.17)
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = rgba(dark ? '220,200,170' : '70,54,40', dark ? 0.22 : 0.2)
  ctx.stroke()
  band(ctx, line, r, seed + 9, 0.24, taper)
  ctx.fillStyle = rgba(deep, dark ? 0.32 : 0.22)
  ctx.fill()

  // Cycloidal suction loops: a point riding the vortex as it moves forward.
  const loops = (radius: number, pitch: number, phase: number, alpha: number, width: number) => {
    ctx.beginPath()
    for (let i = 0; i < line.length; i++) {
      const p = line[i]
      const th = p.s / (pitch * r) + phase
      const k = taper(p.s)
      const along = Math.cos(th) * radius * r * k
      const across = Math.sin(th) * radius * r * k
      const x = p.x + p.ny * -along + p.nx * across
      const y = p.y + p.nx * along + p.ny * across
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.lineWidth = width
    ctx.strokeStyle = rgba(dark ? '215,192,160' : '58,44,32', alpha)
    ctx.stroke()
  }
  ctx.lineJoin = 'round'
  loops(0.46, 0.17, seed % 7, dark ? 0.2 : 0.22, 1.1)
  loops(0.3, 0.13, (seed % 5) + 2, dark ? 0.13 : 0.15, 0.8)

  // Debris specks, laid down as the vortex passes.
  const all = specks(seed)
  const want = Math.min(all.length, Math.round((full / r) * 34))
  const light = new Path2D()
  const dim = new Path2D()
  for (let i = 0; i < want; i++) {
    const sp = all[Math.floor((i / want) * all.length)]
    const s = sp.u * full
    if (s > swept) continue
    const p = sampleAt(line, s)
    const k = taper(s)
    const x = p.x + p.nx * sp.off * r * k
    const y = p.y + p.ny * sp.off * r * k
    const l = sp.size * 0.7
    const dx = Math.cos(sp.angle) * l
    const dy = Math.sin(sp.angle) * l
    const target = sp.shade < 0.55 ? dim : light
    target.moveTo(x - dx, y - dy)
    target.lineTo(x + dx, y + dy)
  }
  ctx.lineCap = 'round'
  ctx.lineWidth = 1.4
  ctx.strokeStyle = rgba(deep, dark ? 0.55 : 0.5)
  ctx.stroke(dim)
  ctx.lineWidth = 1.1
  ctx.strokeStyle = rgba(dark ? '226,208,180' : '120,96,74', dark ? 0.45 : 0.5)
  ctx.stroke(light)

  // Fresh dust still settling right behind the vortex.
  const settle = smoothstep(0, r * 0.6, full - swept)
  if (a.live && swept > 2 && settle > 0) {
    const head = line[line.length - 1]
    const back = sampleAt(line, Math.max(0, swept - r * 4))
    const g = ctx.createLinearGradient(head.x, head.y, back.x, back.y)
    g.addColorStop(0, rgba(soil, (dark ? 0.2 : 0.18) * settle))
    g.addColorStop(1, rgba(soil, 0))
    ctx.beginPath()
    const from = Math.max(0, line.length - 1 - Math.ceil((r * 4) / (line[1].s - line[0].s || 1)))
    for (let i = from; i < line.length; i++) {
      if (i === from) ctx.moveTo(line[i].x, line[i].y)
      else ctx.lineTo(line[i].x, line[i].y)
    }
    ctx.lineCap = 'round'
    ctx.lineWidth = r * 1.5
    ctx.strokeStyle = g
    ctx.stroke()
  }
  ctx.restore()
}

/** Add a tapered log-spiral ribbon from `inner` to `outer` px around (cx, cy). */
function ribbon(path: Path2D, cx: number, cy: number, inner: number, outer: number, angle: number, wind: number, width: number) {
  const steps = 18
  const xs: number[] = []
  const ys: number[] = []
  const ws: number[] = []
  for (let j = 0; j <= steps; j++) {
    const u = j / steps
    const rad = inner * Math.pow(outer / inner, u)
    const th = angle + u * wind
    xs.push(cx + Math.cos(th) * rad)
    ys.push(cy + Math.sin(th) * rad)
    ws.push(width * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.1)), 0.9) + 0.3)
  }
  const back: number[] = []
  for (let j = 0; j <= steps; j++) {
    const p = Math.max(0, j - 1)
    const q = Math.min(steps, j + 1)
    const tx = xs[q] - xs[p]
    const ty = ys[q] - ys[p]
    const l = Math.hypot(tx, ty) || 1
    const ox = (-ty / l) * ws[j]
    const oy = (tx / l) * ws[j]
    if (j === 0) path.moveTo(xs[j] + ox, ys[j] + oy)
    else path.lineTo(xs[j] + ox, ys[j] + oy)
    back.push(xs[j] - ox, ys[j] - oy)
  }
  for (let j = steps; j >= 0; j--) path.lineTo(back[j * 2], back[j * 2 + 1])
  path.closePath()
}

function cell(f: Frame, a: CellArgs) {
  const { ctx, dark } = f
  const r = a.radiusPx
  const k = a.intensity
  if (r < 1 || k <= 0) return
  const lv = Math.max(0, Math.min(3, a.level))
  const t = f.now / 1000
  const seed = a.seed
  const spin = 3.4 + lv * 1.25
  const turn = -spin * t
  const wob = r * (0.05 + lv * 0.018)
  const cx = a.head.x + (noise1(t * 1.1, seed) - 0.5) * 2 * wob
  const cy = a.head.y + (noise1(t * 1.1, seed + 7) - 0.5) * 2 * wob
  const { flecks, thrown, arms } = debris(seed, lv)
  const smoke = dark ? '128,122,116' : '78,72,66'
  const pale = dark ? '236,232,224' : '250,248,244'
  const dust = dark ? '176,156,128' : '118,100,82'

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Parent mesocyclone: a faint wide rotation with inflow wisps feeding the vortex.
  const meso = r * 2.6
  const mg = ctx.createRadialGradient(cx, cy, r * 1.1, cx, cy, meso)
  mg.addColorStop(0, rgba(smoke, 0))
  mg.addColorStop(0.6, rgba(smoke, (dark ? 0.1 : 0.07) * k))
  mg.addColorStop(1, rgba(smoke, 0))
  ctx.fillStyle = mg
  ctx.beginPath()
  ctx.arc(cx, cy, meso, 0, TAU)
  ctx.fill()
  const wisps = new Path2D()
  const slow = -t * (0.8 + lv * 0.25)
  for (let i = 0; i < 6; i++) {
    const base = slow + (i / 6) * TAU + (seed % 13)
    ribbon(wisps, cx, cy, r * 1.05, meso * (0.92 + 0.08 * Math.sin(i * 2.3)), base, 2.1 + (i % 2) * 0.5, r * 0.1)
  }
  ctx.fillStyle = rgba(dark ? pale : smoke, (dark ? 0.075 : 0.11) * k)
  ctx.fill(wisps)

  // Ragged debris cloud skirting the vortex at ground level.
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < 40; i++) {
    const th = (i / 40) * TAU
    const n = noise1(i * 0.55 + t * 2.4, seed + 3) * 0.5 + noise1(i * 1.7 - t * 4, seed + 4) * 0.25
    const rad = r * (1.12 + n * 0.55)
    xs.push(cx + Math.cos(th + turn * 0.3) * rad)
    ys.push(cy + Math.sin(th + turn * 0.3) * rad)
  }
  const sg = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r * 1.7)
  sg.addColorStop(0, rgba(dust, 0.1 * k))
  sg.addColorStop(0.55, rgba(dust, 0.24 * k))
  sg.addColorStop(1, rgba(dust, 0))
  ctx.fillStyle = sg
  ctx.beginPath()
  traceLoop(ctx, xs, ys)
  ctx.fill()

  // Spiral cloud bands: smoky arms, with lit leading edges.
  const smokeArms = new Path2D()
  const litArms = new Path2D()
  for (const arm of arms) {
    ribbon(smokeArms, cx, cy, r * 0.18, arm.reach * r * 1.12, turn + arm.angle, arm.wind, r * arm.width * 0.17)
    ribbon(litArms, cx, cy, r * 0.22, arm.reach * r, turn + arm.angle - 0.16, arm.wind * 0.96, r * arm.width * 0.06)
  }
  const bands = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.3)
  bands.addColorStop(0, rgba(smoke, 0.9 * k))
  bands.addColorStop(0.45, rgba(smoke, (dark ? 0.75 : 0.62) * k))
  bands.addColorStop(0.85, rgba(smoke, 0.28 * k))
  bands.addColorStop(1, rgba(smoke, 0))
  ctx.fillStyle = bands
  ctx.fill(smokeArms)
  const glints = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r * 1.1)
  glints.addColorStop(0, rgba(pale, 0.85 * k))
  glints.addColorStop(0.5, rgba(pale, (dark ? 0.6 : 0.7) * k))
  glints.addColorStop(1, rgba(pale, 0))
  ctx.fillStyle = glints
  ctx.fill(litArms)

  // Orbiting debris, smeared along its motion. Inner flecks whip round fastest.
  const bits = [new Path2D(), new Path2D(), new Path2D(), new Path2D()]
  for (const d of flecks) {
    const omega = (spin * d.speed * 1.2) / Math.pow(d.orbit, 0.9)
    const th = d.phase - omega * t
    const rad = d.orbit * r * (1 + 0.06 * Math.sin(t * 3 + d.phase * 5))
    const sweep = Math.min(0.2, (d.size * 1.1) / rad + omega * 0.007 * d.speed)
    const target = bits[(d.shade < 0.6 ? 0 : 2) + (d.size > 1.7 ? 1 : 0)]
    target.moveTo(cx + Math.cos(th) * rad, cy + Math.sin(th) * rad)
    target.lineTo(cx + Math.cos(th + sweep) * rad, cy + Math.sin(th + sweep) * rad)
  }
  const bit = Math.max(0.9, Math.min(2.2, r * 0.018))
  const darkBit = rgba(dark ? '36,30,25' : '36,28,22', 0.85 * k)
  const paleBit = rgba(dark ? '234,220,196' : '150,124,98', 0.85 * k)
  ctx.lineWidth = bit
  ctx.strokeStyle = darkBit
  ctx.stroke(bits[0])
  ctx.strokeStyle = paleBit
  ctx.stroke(bits[2])
  ctx.lineWidth = bit * 1.8
  ctx.strokeStyle = darkBit
  ctx.stroke(bits[1])
  ctx.strokeStyle = paleBit
  ctx.stroke(bits[3])

  // Debris flung out along the tangent, slowing and fading as it goes.
  for (let pass = 0; pass < 2; pass++) {
    const flung = new Path2D()
    for (const d of thrown) {
      if ((d.shade < 0.5) !== (pass === 0)) continue
      const ph = frac(t / d.period + d.offset)
      const born = t - ph * d.period
      const th = d.angle - spin * born
      const sx = cx + Math.cos(th) * r * 0.85
      const sy = cy + Math.sin(th) * r * 0.85
      const tx = Math.sin(th) + Math.cos(th) * 0.45
      const ty = -Math.cos(th) + Math.sin(th) * 0.45
      const v = r * (1.7 + lv * 0.45) * d.speed
      const age = ph * d.period
      const go = (s: number) => v * (s - 0.3 * s * s)
      const p1 = go(age)
      const p0 = go(Math.max(0, age - 0.035))
      flung.moveTo(sx + tx * p0, sy + ty * p0)
      flung.lineTo(sx + tx * p1, sy + ty * p1)
    }
    ctx.lineWidth = bit * (pass === 0 ? 1.2 : 1)
    ctx.strokeStyle = pass === 0 ? rgba(dark ? '52,44,36' : '44,34,26', 0.75 * k) : rgba(dark ? '226,210,184' : '128,104,82', 0.7 * k)
    ctx.stroke(flung)
  }

  // The violent core, with a bright churning wall around it.
  const coreR = r * (0.46 + lv * 0.03)
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR)
  core.addColorStop(0, rgba('6,5,4', 0.97 * k))
  core.addColorStop(0.4, rgba('16,13,11', 0.88 * k))
  core.addColorStop(0.75, rgba('30,26,23', 0.4 * k))
  core.addColorStop(1, rgba('30,26,23', 0))
  ctx.fillStyle = core
  ctx.beginPath()
  ctx.arc(cx, cy, coreR, 0, TAU)
  ctx.fill()
  const wall = r * 0.25
  for (let i = 0; i < 4; i++) {
    const s0 = turn * 1.7 + (i / 4) * TAU + noise1(t * 1.5 + i * 3, seed) * 1.2
    ctx.beginPath()
    ctx.arc(cx, cy, wall * (0.9 + i * 0.09), s0, s0 + 0.9 + noise1(t * 2 + i, seed) * 0.9)
    ctx.lineWidth = Math.max(1, r * (0.03 - i * 0.004))
    ctx.strokeStyle = rgba(pale, (dark ? 0.6 : 0.8) * k * (1 - i * 0.15))
    ctx.stroke()
  }
  ctx.restore()
}

export const tornado: KindRenderer = { track, cell }
