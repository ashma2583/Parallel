/**
 * Blizzard: a whiteout of streaming, swirling snow, leaving a blanket of snow
 * with wind-drift ridges across the direction it blew.
 */
import {
  blob,
  cached,
  clamp,
  distToPath,
  fillBlob,
  gridSites,
  hash2,
  noisyLoop,
  resample,
  rgba,
  star,
  TAU,
  traceBlob,
  traceRuns,
  twinkle,
  unitPx,
  type Sample,
} from './b-shared'
import type { KindRenderer } from './types'
import { noise1, pathLengthPx, rng } from './util'

interface Palette {
  snow: string
  haze: string
  cloud: string
  shadow: string
  ridge: string
  ridgeShade: string
  blanket: number[]
}

const DARK: Palette = {
  snow: '248,250,252',
  haze: '226,232,240',
  cloud: '203,213,225',
  shadow: '15,23,42',
  ridge: '255,255,255',
  ridgeShade: '15,23,42',
  blanket: [0.05, 0.11, 0.09, 0.08],
}

const LIGHT: Palette = {
  snow: '255,255,255',
  haze: '255,255,255',
  cloud: '148,163,184',
  shadow: '71,85,105',
  ridge: '255,255,255',
  ridgeShade: '71,85,105',
  blanket: [0.12, 0.26, 0.16, 0.12],
}

/** Wind for a storm dropped in place, which has no track to blow along. */
function windOf(seed: number): number {
  return 0.15 + ((seed % 1000) / 1000) * 0.7
}

interface Flake {
  u: number
  v: number
  speed: number
  size: number
  wobble: number
  phase: number
}

interface Gust {
  u: number
  v: number
  len: number
  speed: number
  bow: number
}

interface Puff {
  u: number
  v: number
  size: number
  speed: number
}

function flakes(seed: number, count: number): Flake[] {
  return cached(`bliz-flakes-${seed}-${count}`, () => {
    const r = rng(seed ^ 0xb11e)
    return Array.from({ length: count }, () => ({
      u: r() * 2.4 - 1.2,
      v: r() * 2 - 1,
      speed: 0.55 + r() * 0.9,
      size: r() < 0.5 ? 0 : r() < 0.5 ? 1 : 2,
      wobble: 0.015 + r() * 0.035,
      phase: r() * TAU,
    }))
  })
}

function gusts(seed: number): Gust[] {
  return cached(`bliz-gusts-${seed}`, () => {
    const r = rng(seed ^ 0x6057)
    return Array.from({ length: 26 }, () => ({
      u: r() * 2.6 - 1.3,
      v: (r() * 2 - 1) * 0.9,
      len: 0.25 + r() * 0.4,
      speed: 0.9 + r() * 0.7,
      bow: (r() - 0.5) * 0.12,
    }))
  })
}

function puffs(seed: number): Puff[] {
  return cached(`bliz-puffs-${seed}`, () => {
    const r = rng(seed ^ 0x9f0f)
    return Array.from({ length: 7 }, () => ({ u: r() * 2.4 - 1.2, v: (r() * 2 - 1) * 0.7, size: 0.22 + r() * 0.18, speed: 0.12 + r() * 0.12 }))
  })
}

/** Wrap a value into [-w, w). */
function wrap(v: number, w: number): number {
  return ((((v + w) % (2 * w)) + 2 * w) % (2 * w)) - w
}

export const blizzard: KindRenderer = {
  track(f, a) {
    const r = a.radiusPx
    if (r < 2 || a.swept.length === 0) return
    const { ctx } = f
    const p = f.dark ? DARK : LIGHT
    const unit = unitPx(a.kind, a.level, f.pxPerMeter, r)
    const origin = a.path[0] ?? a.swept[0]
    const opts = { seed: a.seed, rough: 0.13, unit, origin, freq: 2.6 }
    const cover = blob(a.swept, r, opts)
    const t = f.now / 1000

    ctx.save()
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    if (!f.dark) {
      // A cool shadow under the drift edge, so white reads on the pale map.
      ctx.save()
      ctx.translate(1.5, 2.5)
      ctx.beginPath()
      traceRuns(ctx, cover.outline)
      ctx.strokeStyle = rgba(p.shadow, 0.1)
      ctx.lineWidth = 9
      ctx.stroke()
      ctx.strokeStyle = rgba(p.shadow, 0.2)
      ctx.lineWidth = 3
      ctx.stroke()
      ctx.restore()
    }
    fillBlob(ctx, blob(a.swept, r, { ...opts, scale: 1.1 }), rgba(p.snow, p.blanket[0]))
    fillBlob(ctx, cover, rgba(p.snow, p.blanket[1]))
    fillBlob(ctx, blob(a.swept, r, { ...opts, scale: 0.76, seed: a.seed + 1 }), rgba(p.snow, p.blanket[2]))
    fillBlob(ctx, blob(a.swept, r, { ...opts, scale: 0.48, seed: a.seed + 2 }), rgba(p.snow, p.blanket[3]))

    // Drift ridges across the wind: a bright crest with a shadow on its lee side.
    ctx.save()
    ctx.beginPath()
    traceBlob(ctx, cover)
    ctx.clip()
    const spacing = clamp(unit * 0.06, 13, 34)
    let rows: { s: Sample; half: number }[]
    const len = pathLengthPx(a.swept)
    if (a.swept.length < 2 || len < spacing) {
      const c = a.swept[a.swept.length - 1]
      const w = windOf(a.seed)
      rows = []
      const n = Math.ceil(r / spacing)
      for (let i = -n; i <= n; i++) {
        const s = i * spacing
        rows.push({ s: { x: c.x + Math.cos(w) * s, y: c.y + Math.sin(w) * s, angle: w, s }, half: Math.sqrt(Math.max(0, r * r - s * s)) * 1.05 })
      }
    } else {
      rows = resample(a.swept, spacing, 4).map((s) => ({ s, half: r * 1.05 }))
    }
    // Ripples run in broken, gently waving crests; neighbours stay roughly parallel.
    const crest = new Path2D()
    const lee = new Path2D()
    const step = spacing * 0.5
    const lam = spacing * 2.2
    rows.forEach(({ s, half }) => {
      if (half < spacing * 0.5) return
      if (s.x < -half || s.y < -half || s.x > f.width + half || s.y > f.height + half) return
      const ux = Math.cos(s.angle)
      const uy = Math.sin(s.angle)
      const row = Math.round(s.s / spacing)
      const phase = row * 0.45 + noise1(row * 0.3, a.seed) * 3
      const shift = (hash2(row, 0, a.seed) - 0.5) * spacing * 0.5
      let d = -half + hash2(row, 1, a.seed) * spacing * 3
      for (let q = 2; d < half; q++) {
        const run = spacing * (2.5 + 5 * hash2(row, q, a.seed))
        const end = Math.min(half, d + run)
        let first = true
        for (let e = d; e <= end; e += step) {
          const taper = Math.min(1, (e - d) / spacing, (end - e) / spacing)
          const off = shift + Math.sin(e / lam + phase) * spacing * 0.32 * (0.5 + 0.5 * taper)
          const x = s.x - uy * e + ux * off
          const y = s.y + ux * e + uy * off
          if (first) {
            crest.moveTo(x, y)
            lee.moveTo(x + ux * 1.6, y + uy * 1.6)
          } else {
            crest.lineTo(x, y)
            lee.lineTo(x + ux * (1.2 + 1.4 * taper), y + uy * (1.2 + 1.4 * taper))
          }
          first = false
        }
        d = end + spacing * (0.6 + 1.8 * hash2(row, q, a.seed + 1))
      }
    })
    ctx.lineWidth = 1.8
    ctx.strokeStyle = rgba(p.ridgeShade, f.dark ? 0.26 : 0.18)
    ctx.stroke(lee)
    ctx.strokeStyle = rgba(p.ridge, f.dark ? 0.15 : 0.95)
    ctx.lineWidth = 1.2
    ctx.stroke(crest)
    ctx.restore()

    // Drift edge.
    ctx.beginPath()
    traceRuns(ctx, cover.outline)
    if (f.dark) {
      ctx.strokeStyle = rgba(p.snow, 0.1)
      ctx.lineWidth = 5
      ctx.stroke()
      ctx.strokeStyle = rgba(p.snow, 0.4)
      ctx.lineWidth = 1.1
      ctx.stroke()
    } else {
      ctx.strokeStyle = rgba(p.snow, 0.9)
      ctx.lineWidth = 2.2
      ctx.stroke()
      ctx.strokeStyle = rgba(p.cloud, 0.75)
      ctx.lineWidth = 0.9
      ctx.stroke()
    }

    // Faint sparkle on the snow.
    const cell = clamp(unit * 0.07, 14, 40)
    const glint = new Path2D()
    for (const s of gridSites(a.path.length ? a.path : a.swept, unit * 0.95, cell, origin, a.seed + 9, { w: f.width, h: f.height })) {
      if (s.h > 0.07) continue
      const tw = twinkle(t, 1.1 + s.h * 9, s.h * 211, 8)
      if (tw < 0.05 || (a.live && distToPath(s.x, s.y, a.swept) > r * 0.95)) continue
      star(glint, s.x, s.y, 1.5 + tw * 3.5, 0.12)
    }
    ctx.globalCompositeOperation = f.dark ? 'lighter' : 'source-over'
    ctx.fillStyle = f.dark ? rgba(p.snow, 0.8) : rgba('100,116,139', 0.8)
    ctx.fill(glint)
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
    const wind = a.stationary ? windOf(a.seed) + Math.sin(T * 0.3) * 0.25 : a.heading
    const ux = Math.cos(wind)
    const uy = Math.sin(wind)
    const toX = (u: number, v: number) => x + (ux * u - uy * v) * r
    const toY = (u: number, v: number) => y + (uy * u + ux * v) * r

    ctx.save()
    ctx.globalAlpha = k

    // Haze body: a cloud-grey skirt on the light map, white layers over it.
    if (!f.dark) {
      ctx.beginPath()
      noisyLoop(ctx, x, y, r * 1.08, 0.12, a.seed + 1, T * 0.2)
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.1)
      g.addColorStop(0, rgba(p.cloud, 0.12))
      g.addColorStop(0.7, rgba(p.cloud, 0.2))
      g.addColorStop(0.93, rgba(p.cloud, 0.32))
      g.addColorStop(1, rgba(p.cloud, 0.12))
      ctx.fillStyle = g
      ctx.fill()
    }
    const layers: [number, number][] = f.dark
      ? [
          [1.12, 0.05],
          [1.0, 0.07],
          [0.8, 0.06],
          [0.5, 0.06],
        ]
      : [
          [1.0, 0.08],
          [0.75, 0.1],
          [0.45, 0.12],
        ]
    layers.forEach(([s, alpha], i) => {
      ctx.beginPath()
      noisyLoop(ctx, x, y, r * s, 0.1, a.seed + 7 * i, T * 0.25 + i * 2)
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * s)
      g.addColorStop(0, rgba(p.haze, alpha * 1.4))
      g.addColorStop(0.7, rgba(p.haze, alpha))
      g.addColorStop(1, rgba(p.haze, alpha * 0.4))
      ctx.fillStyle = g
      ctx.fill()
    })

    // Spiral bands of heavier snow, turning slowly round the core.
    ctx.lineCap = 'round'
    const spin = T * 0.35 + (a.seed % 628) / 100
    for (let arm = 0; arm < 3; arm++) {
      const band = new Path2D()
      const base = spin + (arm * TAU) / 3
      for (let q = 0; q <= 24; q++) {
        const tq = q / 24
        const rho = 0.12 + tq * 0.8
        const th = base + tq * 2.4
        const bx = x + Math.cos(th) * rho * r
        const by = y + Math.sin(th) * rho * r
        if (q === 0) band.moveTo(bx, by)
        else band.lineTo(bx, by)
      }
      for (const [w, alpha] of [
        [0.18, 0.045],
        [0.07, 0.07],
      ]) {
        ctx.lineWidth = r * w
        ctx.strokeStyle = rgba(p.haze, alpha * (f.dark ? 1 : 2.2))
        ctx.stroke(band)
      }
    }

    // Billows of snow drifting downwind.
    for (const pf of puffs(a.seed)) {
      const u = wrap(pf.u + T * pf.speed, 1.2)
      const fade = 1 - Math.abs(u) / 1.2
      const px = toX(u * 0.85, pf.v)
      const py = toY(u * 0.85, pf.v)
      const pr = pf.size * r
      const g = ctx.createRadialGradient(px, py, 0, px, py, pr)
      g.addColorStop(0, rgba(p.haze, (f.dark ? 0.12 : 0.28) * fade))
      g.addColorStop(1, rgba(p.haze, 0))
      ctx.fillStyle = g
      ctx.fillRect(px - pr, py - pr, pr * 2, pr * 2)
    }

    // Gusts: long thin streaks racing through.
    const gust = new Path2D()
    for (const g of gusts(a.seed)) {
      const u = wrap(g.u + T * g.speed, 1.3)
      const life = 1 - Math.abs(u) / 1.3
      if (life < 0.15) continue
      const v = g.v
      const rho = Math.hypot(u, v)
      if (rho > 1.05) continue
      const u0 = u - g.len * life
      gust.moveTo(toX(u0, v), toY(u0, v))
      gust.quadraticCurveTo(toX((u + u0) / 2, v + g.bow), toY((u + u0) / 2, v + g.bow), toX(u, v), toY(u, v))
    }
    ctx.lineCap = 'round'
    if (!f.dark) {
      ctx.strokeStyle = rgba(p.shadow, 0.18)
      ctx.lineWidth = 2.2
      ctx.stroke(gust)
    }
    ctx.strokeStyle = rgba(p.snow, f.dark ? 0.22 : 0.75)
    ctx.lineWidth = 1.2
    ctx.stroke(gust)

    // Snow: hundreds of flakes streaming with the wind, twisted into a swirl.
    const count = a.level >= 2 ? 1100 : a.level === 1 ? 900 : 650
    const sizes = [clamp(r * 0.005, 1.8, 2.6), clamp(r * 0.008, 2.6, 3.8), clamp(r * 0.005, 1.6, 2.4)]
    const buckets = Array.from({ length: 6 }, () => new Path2D())
    const streak = clamp(r * 0.014, 3, 9)
    const place = (fl: Flake, time: number): [number, number, number] => {
      const u = wrap(fl.u + time * fl.speed * 0.42, 1.2)
      const v = fl.v + Math.sin(time * 1.4 * fl.speed + fl.phase) * fl.wobble + (noise1(u * 1.6 + fl.phase, a.seed) - 0.5) * 0.12
      const rho = Math.hypot(u, v)
      const twist = 0.85 * (1 - Math.min(1, rho)) ** 2
      const c = Math.cos(twist)
      const sn = Math.sin(twist)
      return [toX(u * c - v * sn, u * sn + v * c), toY(u * c - v * sn, u * sn + v * c), rho]
    }
    for (const fl of flakes(a.seed, count)) {
      const [px, py, rho] = place(fl, T)
      if (rho > 1.02) continue
      const b = buckets[fl.size * 2 + (rho > 0.75 ? 1 : 0)]
      b.moveTo(px, py)
      if (fl.size < 2) {
        b.lineTo(px + 0.01, py)
      } else {
        const [qx, qy] = place(fl, T - 0.09)
        const dx = px - qx
        const dy = py - qy
        const l = Math.hypot(dx, dy) || 1
        const tail = Math.min(l, streak * fl.speed) + 1
        b.lineTo(px - (dx / l) * tail, py - (dy / l) * tail)
      }
    }
    ctx.lineCap = 'round'
    const alphaIn = f.dark ? [0.85, 0.75, 0.7] : [1, 1, 0.95]
    if (!f.dark) {
      ctx.save()
      ctx.translate(0.5, 0.8)
      ctx.strokeStyle = rgba(p.shadow, 0.5)
      buckets.forEach((b, i) => {
        ctx.lineWidth = sizes[i >> 1] + 0.8
        ctx.stroke(b)
      })
      ctx.restore()
    }
    buckets.forEach((b, i) => {
      const size = i >> 1
      ctx.lineWidth = sizes[size]
      ctx.strokeStyle = rgba(p.snow, alphaIn[size] * (i % 2 ? 0.55 : 1))
      ctx.stroke(b)
    })

    // A few big soft flakes rushing past close to the eye.
    ctx.globalCompositeOperation = f.dark ? 'screen' : 'source-over'
    for (const fl of flakes(a.seed, count).slice(0, 22)) {
      const u = wrap(fl.u * 1.3 + T * fl.speed * 0.9, 1.15)
      const v = fl.v * 0.85 + Math.sin(T * 1.3 + fl.phase) * 0.06
      if (Math.hypot(u, v) > 0.95) continue
      const px = toX(u, v)
      const py = toY(u, v)
      const br = clamp(r * 0.018, 4, 9) * (0.7 + fl.speed * 0.4)
      const g = ctx.createRadialGradient(px, py, 0, px, py, br)
      g.addColorStop(0, rgba(p.snow, f.dark ? 0.55 : 0.9))
      g.addColorStop(0.45, rgba(p.snow, f.dark ? 0.25 : 0.5))
      g.addColorStop(1, rgba(p.snow, 0))
      ctx.fillStyle = g
      ctx.fillRect(px - br, py - br, br * 2, br * 2)
    }
    ctx.globalCompositeOperation = 'source-over'

    // Ragged rim of blowing snow, marching round.
    ctx.beginPath()
    noisyLoop(ctx, x, y, r, 0.1, a.seed + 7, T * 0.25 + 2)
    ctx.strokeStyle = rgba(f.dark ? p.snow : p.cloud, f.dark ? 0.16 : 0.45)
    ctx.lineWidth = f.dark ? 3 : 1.2
    ctx.setLineDash([2, 6])
    ctx.lineDashOffset = -T * 30
    ctx.stroke()
    ctx.restore()
  },
}
