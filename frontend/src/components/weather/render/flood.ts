/**
 * Flash flood: a surge of deep water rolling along the path with ripples,
 * caustic light and rain dimples, leaving standing water with a foam line.
 */
import { blob, cached, clamp, distToPath, fillBlob, frac, gridSites, loopRadius, noisyLoop, resample, rgba, TAU, traceBlob, traceRuns, twinkle, unitPx } from './b-shared'
import type { KindRenderer } from './types'
import { pathLengthPx, rng } from './util'

interface Palette {
  wet: string
  water: string
  mid: string
  deep: string
  hi: string
  foam: string
  edge: string
  layers: number[]
  blend: GlobalCompositeOperation
}

const DARK: Palette = {
  wet: '96,165,250',
  water: '59,130,246',
  mid: '37,99,235',
  deep: '23,52,140',
  hi: '191,219,254',
  foam: '219,234,254',
  edge: '147,197,253',
  layers: [0.07, 0.2, 0.15, 0.2],
  blend: 'lighter',
}

const LIGHT: Palette = {
  wet: '96,165,250',
  water: '59,130,246',
  mid: '37,99,235',
  deep: '29,78,216',
  hi: '255,255,255',
  foam: '255,255,255',
  edge: '29,78,216',
  layers: [0.08, 0.22, 0.14, 0.16],
  blend: 'source-over',
}

interface Drop {
  slot: number
  period: number
  offset: number
}

function drops(seed: number): Drop[] {
  return cached(`flood-drops-${seed}`, () => {
    const r = rng(seed ^ 0xd209)
    return Array.from({ length: 24 }, (_, slot) => ({ slot, period: 0.7 + r() * 0.6, offset: r() }))
  })
}

export const flood: KindRenderer = {
  track(f, a) {
    const r = a.radiusPx
    if (r < 2 || a.swept.length === 0) return
    const { ctx } = f
    const p = f.dark ? DARK : LIGHT
    const unit = unitPx(a.kind, a.level, f.pxPerMeter, r)
    const origin = a.path[0] ?? a.swept[0]
    const opts = { seed: a.seed, rough: 0.18, unit, origin, freq: 2.4 }
    const shore = blob(a.swept, r, opts)
    const t = f.now / 1000

    ctx.save()
    fillBlob(ctx, blob(a.swept, r, { ...opts, scale: 1.12 }), rgba(p.wet, p.layers[0]))
    fillBlob(ctx, shore, rgba(p.water, p.layers[1]))
    fillBlob(ctx, blob(a.swept, r, { ...opts, scale: 0.72, seed: a.seed + 1 }), rgba(p.mid, p.layers[2]))
    fillBlob(ctx, blob(a.swept, r, { ...opts, scale: 0.42, seed: a.seed + 2 }), rgba(p.deep, p.layers[3]))

    // Slow wave lines drifting across the surface.
    ctx.save()
    ctx.beginPath()
    traceBlob(ctx, shore)
    ctx.clip()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const waves = new Path2D()
    const len = pathLengthPx(a.swept)
    if (a.swept.length < 2 || len < r * 0.2) {
      const c = a.swept[a.swept.length - 1]
      for (let i = 1; i <= 5; i++) {
        const rr = (i / 5.6) * r
        const sides = Math.round(clamp(rr * 0.3, 16, 80))
        for (let k = 0; k <= sides; k++) {
          const th = (k / sides) * TAU
          const w = rr + Math.sin(th * 6 + t * 0.9 + i * 1.3) * r * 0.025
          const x = c.x + Math.cos(th) * w
          const y = c.y + Math.sin(th) * w
          if (k === 0) waves.moveTo(x, y)
          else waves.lineTo(x, y)
        }
      }
    } else {
      const samples = resample(a.swept, clamp(r * 0.07, 5, 12), 3)
      const lines = 6
      for (let i = 0; i < lines; i++) {
        const d = (-0.75 + (1.5 * i) / (lines - 1)) * r
        const k = TAU / (r * (0.9 + 0.25 * (i % 3)))
        samples.forEach((s, n) => {
          const off = d + Math.sin(s.s * k + t * 0.8 + i * 1.7) * r * 0.07
          const x = s.x - Math.sin(s.angle) * off
          const y = s.y + Math.cos(s.angle) * off
          if (n === 0) waves.moveTo(x, y)
          else waves.lineTo(x, y)
        })
      }
    }
    const dash = clamp(unit * 0.5, 30, 140)
    ctx.setLineDash([dash, dash * 0.55])
    ctx.lineDashOffset = -t * dash * 0.12
    ctx.globalCompositeOperation = p.blend
    ctx.strokeStyle = rgba(p.hi, f.dark ? 0.13 : 0.32)
    ctx.lineWidth = 1.2
    ctx.stroke(waves)
    ctx.setLineDash([])

    // Glints: short crescents of light that come and go on the surface.
    const cell = clamp(unit * 0.22, 18, 60)
    const glints = new Path2D()
    for (const s of gridSites(a.path.length ? a.path : a.swept, unit * 0.85, cell, origin, a.seed + 5, { w: f.width, h: f.height })) {
      if (s.h > 0.5) continue
      const tw = twinkle(t, 0.8 + s.h * 2, s.h * 77, 4)
      if (tw < 0.08 || (a.live && distToPath(s.x, s.y, a.swept) > r * 0.85)) continue
      const w = cell * (0.18 + 0.22 * tw)
      glints.moveTo(s.x - w, s.y)
      glints.quadraticCurveTo(s.x, s.y - w * 0.45, s.x + w, s.y)
    }
    ctx.lineCap = 'round'
    ctx.lineWidth = 1.4
    ctx.strokeStyle = rgba(p.hi, f.dark ? 0.4 : 0.85)
    ctx.stroke(glints)
    ctx.restore()

    // Shoreline: a foam band with a crisp waterline, and broken foam just inside it.
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    traceRuns(ctx, shore.outline)
    ctx.strokeStyle = rgba(p.foam, f.dark ? 0.14 : 0.75)
    ctx.lineWidth = f.dark ? 4 : 3.5
    ctx.stroke()
    ctx.strokeStyle = rgba(p.edge, f.dark ? 0.55 : 0.6)
    ctx.lineWidth = 1.1
    ctx.stroke()
    const inner = blob(a.swept, r, { ...opts, scale: 0.9 })
    ctx.beginPath()
    traceRuns(ctx, inner.outline)
    ctx.setLineDash([1.5, 5.5])
    ctx.lineDashOffset = t * 3
    ctx.strokeStyle = rgba(p.foam, f.dark ? 0.4 : 0.85)
    ctx.lineWidth = 1.4
    ctx.stroke()
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
    const still = a.stationary
    const stretch = still ? 1 : 1.18
    const squash = still ? 1 : 0.94
    const ang = a.heading
    const ca = Math.cos(ang)
    const sa = Math.sin(ang)
    const body = () => {
      ctx.beginPath()
      noisyLoop(ctx, x, y, r, 0.07, a.seed, T * 0.35, stretch, squash, ang)
    }

    ctx.save()
    ctx.globalAlpha = k

    // Wet halo, then the water body: deep in the middle, brighter at the surge front.
    ctx.beginPath()
    noisyLoop(ctx, x, y, r * 1.13, 0.1, a.seed + 3, T * 0.3, stretch, squash, ang)
    ctx.fillStyle = rgba(p.wet, f.dark ? 0.08 : 0.1)
    ctx.fill()
    body()
    const g = ctx.createRadialGradient(x - ca * r * 0.15, y - sa * r * 0.15, 0, x, y, r * 1.2)
    g.addColorStop(0, rgba(p.deep, f.dark ? 0.55 : 0.38))
    g.addColorStop(0.5, rgba(p.mid, f.dark ? 0.4 : 0.32))
    g.addColorStop(0.85, rgba(p.water, f.dark ? 0.3 : 0.26))
    g.addColorStop(1, rgba(p.water, 0.2))
    ctx.fillStyle = g
    ctx.fill()

    ctx.save()
    body()
    ctx.clip()
    if (!still) {
      const front = ctx.createLinearGradient(x + ca * r * 1.2, y + sa * r * 1.2, x, y)
      front.addColorStop(0, rgba(p.hi, f.dark ? 0.2 : 0.35))
      front.addColorStop(1, rgba(p.hi, 0))
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = front
      ctx.fillRect(x - r * 1.3, y - r * 1.3, r * 2.6, r * 2.6)
    }

    // Caustics: two families of slowly bending light lines that cross into a net.
    ctx.globalCompositeOperation = p.blend
    ctx.lineJoin = 'round'
    const caustic = [new Path2D(), new Path2D()]
    const reach = r * 1.25
    const steps = 18
    for (let fam = 0; fam < 2; fam++) {
      const th = ang + (fam === 0 ? 0.55 : -0.75)
      const ux = Math.cos(th)
      const uy = Math.sin(th)
      for (let i = 0; i < 9; i++) {
        const o = (-1 + (2 * (i + 0.5)) / 9) * reach
        const path = caustic[i % 2]
        for (let s = 0; s <= steps; s++) {
          const u = (-1 + (2 * s) / steps) * reach
          const w =
            Math.sin(u * (6 / r) + T * 1.6 + i * 2.1 + fam) * r * 0.06 +
            Math.sin(u * (13 / r) - T * 2.3 + i * 0.7) * r * 0.025
          const px = x + ux * u - uy * (o + w)
          const py = y + uy * u + ux * (o + w)
          if (s === 0) path.moveTo(px, py)
          else path.lineTo(px, py)
        }
      }
    }
    ctx.lineWidth = clamp(r * 0.012, 1, 2.2)
    ctx.strokeStyle = rgba(p.hi, f.dark ? 0.16 : 0.42)
    ctx.stroke(caustic[0])
    ctx.strokeStyle = rgba(p.hi, f.dark ? 0.09 : 0.26)
    ctx.stroke(caustic[1])

    // Rain dimples: little rings opening and fading all over the surface.
    const dimples = [new Path2D(), new Path2D()]
    const dr = clamp(r * 0.045, 4, 11)
    for (const d of drops(a.seed)) {
      const phase = T / d.period + d.offset
      const cycle = Math.floor(phase)
      const age = phase - cycle
      const rand = rng(a.seed * 31 + d.slot * 977 + cycle * 7919)
      const rho = Math.sqrt(rand()) * 0.9
      const th = rand() * TAU
      const lx = Math.cos(th) * rho * r * stretch
      const ly = Math.sin(th) * rho * r * squash
      const px = x + lx * ca - ly * sa
      const py = y + lx * sa + ly * ca
      const rr = 1 + age * dr
      const path = dimples[age < 0.45 ? 0 : 1]
      path.moveTo(px + rr, py)
      path.arc(px, py, rr, 0, TAU)
      if (age < 0.5) {
        path.moveTo(px + rr * 0.45, py)
        path.arc(px, py, rr * 0.45, 0, TAU)
      }
    }
    ctx.lineWidth = 1
    ctx.strokeStyle = rgba(p.foam, f.dark ? 0.35 : 0.6)
    ctx.stroke(dimples[0])
    ctx.strokeStyle = rgba(p.foam, f.dark ? 0.15 : 0.3)
    ctx.stroke(dimples[1])
    ctx.restore()

    // Ripple rings spreading from the middle.
    ctx.lineJoin = 'round'
    for (let i = 0; i < 4; i++) {
      const age = frac(T / 2.2 + i / 4)
      const rr = r * (0.1 + 0.88 * age)
      ctx.beginPath()
      noisyLoop(ctx, x, y, rr, 0.03, a.seed + 20 + i, T * 0.5, stretch, squash, ang)
      ctx.strokeStyle = rgba(p.hi, (f.dark ? 0.32 : 0.6) * Math.pow(1 - age, 1.4) * Math.min(1, age * 6))
      ctx.lineWidth = 1.6
      ctx.stroke()
    }

    // Edge: a fine bright line all round, heavy foam at the leading front.
    body()
    ctx.strokeStyle = rgba(p.edge, f.dark ? 0.6 : 0.6)
    ctx.lineWidth = 1.2
    ctx.stroke()
    const sides = 64
    const foam = new Path2D()
    const spray = new Path2D()
    const arc = still ? Math.PI : 1.25
    let open = false
    for (let i = 0; i <= sides; i++) {
      const th = -arc + (2 * arc * i) / sides
      const c = Math.cos(th)
      const s = Math.sin(th)
      const er = r * loopRadius(th, 0.07, a.seed, T * 0.35)
      const lx = c * er * stretch
      const ly = s * er * squash
      const px = x + lx * ca - ly * sa
      const py = y + lx * sa + ly * ca
      if (!open) foam.moveTo(px, py)
      else foam.lineTo(px, py)
      open = true
      if (i % 2 === 0) {
        const life = frac(T * 1.3 + ((i * 0.618) % 1))
        const out = 3 + life * clamp(r * 0.08, 6, 18)
        const sx = px + (c * ca - s * sa) * out
        const sy = py + (c * sa + s * ca) * out
        const sr = (1 - life) * 1.8 + 0.4
        spray.moveTo(sx + sr, sy)
        spray.arc(sx, sy, sr, 0, TAU)
      }
    }
    ctx.lineCap = 'round'
    ctx.strokeStyle = rgba(p.foam, f.dark ? 0.22 : 0.6)
    ctx.lineWidth = still ? 4 : 6
    ctx.stroke(foam)
    ctx.strokeStyle = rgba(p.foam, f.dark ? 0.75 : 0.95)
    ctx.lineWidth = still ? 1.4 : 2
    ctx.stroke(foam)
    ctx.fillStyle = rgba(p.foam, f.dark ? 0.55 : 0.85)
    ctx.fill(spray)
    ctx.restore()
  },
}
