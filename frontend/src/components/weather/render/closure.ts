/**
 * Close roads: red and white barricade tape laid along the path, with barrier
 * markers at intervals, led by a crew truck with a flashing, sweeping beacon.
 */
import { clamp, frac, resample, rgba, TAU } from './b-shared'
import type { KindRenderer, Pt } from './types'
import { alongPx, pathLengthPx, swath, tracePath } from './util'

const RED = '220,38,38'
const AMBER = '251,191,36'
const INK = '20,12,12'

function offsetLine(samples: { x: number; y: number; angle: number }[], d: number, out: Path2D): void {
  samples.forEach((s, i) => {
    const x = s.x - Math.sin(s.angle) * d
    const y = s.y + Math.cos(s.angle) * d
    if (i === 0) out.moveTo(x, y)
    else out.lineTo(x, y)
  })
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function easeOutBack(t: number): number {
  const c = 1.9
  const u = t - 1
  return 1 + (c + 1) * u * u * u + c * u * u
}

/** A barrier marker: a dark rounded tile with a red X. */
function marker(ctx: CanvasRenderingContext2D, at: Pt, size: number, dark: boolean): void {
  const h = size / 2
  ctx.beginPath()
  roundRect(ctx, at.x - h, at.y - h + 1.5, size, size, size * 0.24)
  ctx.fillStyle = 'rgba(0,0,0,0.35)'
  ctx.fill()
  ctx.beginPath()
  roundRect(ctx, at.x - h, at.y - h, size, size, size * 0.24)
  ctx.fillStyle = dark ? '#14161a' : '#1b1d22'
  ctx.fill()
  ctx.strokeStyle = '#f8fafc'
  ctx.lineWidth = 1.4
  ctx.stroke()
  const k = size * 0.25
  ctx.beginPath()
  ctx.moveTo(at.x - k, at.y - k)
  ctx.lineTo(at.x + k, at.y + k)
  ctx.moveTo(at.x + k, at.y - k)
  ctx.lineTo(at.x - k, at.y + k)
  ctx.strokeStyle = '#ef4444'
  ctx.lineWidth = Math.max(2, size * 0.16)
  ctx.lineCap = 'round'
  ctx.stroke()
}

export const closure: KindRenderer = {
  track(f, a) {
    const r = a.radiusPx
    const pts = a.swept
    if (r < 1 || pts.length === 0) return
    const { ctx } = f
    const len = pathLengthPx(pts)
    const w = clamp(r * 0.9, 9, 20)

    ctx.save()
    // The closed corridor: a faint red wash with dashed cordon lines along both sides.
    swath(ctx, pts, r * 1.2, rgba(RED, f.dark ? 0.05 : 0.04))
    swath(ctx, pts, r, rgba(RED, f.dark ? 0.1 : 0.08))
    if (pts.length > 1 && len > 2) {
      const samples = resample(pts, 6, 2)
      const cordon = new Path2D()
      offsetLine(samples, r, cordon)
      offsetLine(samples, -r, cordon)
      ctx.setLineDash([7, 5])
      ctx.lineDashOffset = 0
      ctx.strokeStyle = rgba(RED, f.dark ? 0.6 : 0.55)
      ctx.lineWidth = 1.2
      ctx.stroke(cordon)
      ctx.setLineDash([])
    }
    if (len < 2) {
      ctx.restore()
      return
    }

    // Tape: a white band over a dark outline, so it reads on either map.
    ctx.lineJoin = 'round'
    ctx.lineCap = 'butt'
    ctx.beginPath()
    tracePath(ctx, pts)
    ctx.strokeStyle = rgba(INK, 0.9)
    ctx.lineWidth = w + 3.5
    ctx.stroke()

    ctx.strokeStyle = '#f8fafc'
    ctx.lineWidth = w
    ctx.stroke()

    // Red stripes as slanted quads on a smoothed frame, so they bend cleanly round corners.
    // The frame clamps at both ends, which trims the stripes to the tape.
    const step = 3
    const frame = resample(pts, step, 4)
    const at = (s: number): [number, number, number, number] => {
      const q = clamp(s, 0, len) / step
      const i = Math.min(frame.length - 1, Math.floor(q))
      const j = Math.min(frame.length - 1, i + 1)
      const t = q - i
      const A = frame[i]
      const B = frame[j]
      const ang = A.angle + Math.atan2(Math.sin(B.angle - A.angle), Math.cos(B.angle - A.angle)) * t
      return [A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t, -Math.sin(ang), Math.cos(ang)]
    }
    const period = clamp(w * 1.3, 11, 26)
    const half = w / 2
    const stripes = new Path2D()
    const corner = (s: number, side: number) => {
      const [x, y, nx, ny] = at(s + side * half)
      return [x + nx * half * side, y + ny * half * side]
    }
    for (let s0 = -period; s0 < len + period; s0 += period) {
      const s1 = s0 + period / 2
      const a0 = corner(s0, 1)
      const a1 = corner(s1, 1)
      const b1 = corner(s1, -1)
      const b0 = corner(s0, -1)
      stripes.moveTo(a0[0], a0[1])
      stripes.lineTo(a1[0], a1[1])
      stripes.lineTo(b1[0], b1[1])
      stripes.lineTo(b0[0], b0[1])
      stripes.closePath()
    }
    ctx.fillStyle = `rgb(${RED})`
    ctx.fill(stripes)

    // A thin sheen along the tape.
    ctx.beginPath()
    tracePath(ctx, pts)
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.lineWidth = Math.max(1, w * 0.12)
    ctx.stroke()

    // Barrier markers at intervals; while the crew is laying tape, new ones pop in behind it.
    const gap = clamp(r * 4, 70, 150)
    const size = clamp(w * 0.95, 12, 17)
    let last = 0
    for (let s = Math.min(gap * 0.35, len); s <= len + 0.01; s += gap) {
      last = s
      const behind = len - s
      let scale = 1
      if (a.live) scale = behind < 4 ? 0 : easeOutBack(clamp((behind - 4) / 46, 0, 1))
      if (scale <= 0.02) continue
      const at = alongPx(pts, s).p
      ctx.save()
      ctx.translate(at.x, at.y)
      ctx.scale(scale, scale)
      marker(ctx, { x: 0, y: 0 }, size, f.dark)
      ctx.restore()
    }
    if (!a.live) {
      marker(ctx, pts[0], size, f.dark)
      if (len - last > gap * 0.4) marker(ctx, pts[pts.length - 1], size, f.dark)
    }
    ctx.restore()
  },

  cell(f, a) {
    const k = a.intensity
    if (k <= 0.01) return
    const { ctx } = f
    const { x, y } = a.head
    const T = a.elapsed / 1000
    const R = clamp(a.radiusPx, 14, 60)
    const ux = Math.cos(a.heading)
    const uy = Math.sin(a.heading)

    ctx.save()
    ctx.globalAlpha = k

    // Pulse rings.
    for (let i = 0; i < 2; i++) {
      const age = frac(T / 1.4 + i / 2)
      ctx.beginPath()
      ctx.arc(x, y, R * (0.5 + 1.9 * age), 0, TAU)
      ctx.strokeStyle = rgba(RED, 0.75 * (1 - age) ** 2)
      ctx.lineWidth = 2
      ctx.stroke()
    }

    // Rotating beacon sweep: two beams with fading trails.
    ctx.globalCompositeOperation = f.dark ? 'lighter' : 'source-over'
    const reach = R * 2.6
    const g = ctx.createRadialGradient(x, y, 0, x, y, reach)
    g.addColorStop(0, rgba(AMBER, f.dark ? 0.7 : 0.55))
    g.addColorStop(0.35, rgba(AMBER, f.dark ? 0.32 : 0.25))
    g.addColorStop(1, rgba(AMBER, 0))
    ctx.fillStyle = g
    const spin = T * 4.2
    for (let beam = 0; beam < 2; beam++) {
      const lead = spin + beam * Math.PI
      for (let i = 0; i < 5; i++) {
        ctx.globalAlpha = k * (1 - i / 5) ** 1.6
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.arc(x, y, reach, lead - 0.16 * (i + 1), lead - 0.16 * i)
        ctx.closePath()
        ctx.fill()
      }
    }
    ctx.globalAlpha = k
    ctx.globalCompositeOperation = 'source-over'

    // Chevrons marching ahead along the heading.
    const s = clamp(R * 0.3, 6.5, 10)
    const step = s * 1.5
    const lit = Math.floor(T / 0.18) % 3
    for (let i = 0; i < 3; i++) {
      const d = Math.max(R * 0.8, 20) + i * step
      const cx = x + ux * d
      const cy = y + uy * d
      const path = new Path2D()
      path.moveTo(cx - ux * s - uy * s, cy - uy * s + ux * s)
      path.lineTo(cx, cy)
      path.lineTo(cx - ux * s + uy * s, cy - uy * s - ux * s)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = rgba(INK, 0.85)
      ctx.lineWidth = s * 0.85
      ctx.stroke(path)
      ctx.strokeStyle = i === lit ? '#fde68a' : '#f59e0b'
      ctx.lineWidth = s * 0.42
      ctx.stroke(path)
    }

    // The crew truck, with the beacon on its roof.
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(a.heading)
    ctx.beginPath()
    roundRect(ctx, -11, -6.5 + 1.5, 22, 13, 3.5)
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.fill()
    ctx.beginPath()
    roundRect(ctx, -11, -6.5, 22, 13, 3.5)
    ctx.fillStyle = '#1b1d22'
    ctx.fill()
    ctx.strokeStyle = '#f8fafc'
    ctx.lineWidth = 1.3
    ctx.stroke()
    ctx.fillStyle = 'rgba(248,250,252,0.85)'
    ctx.fillRect(5, -4.5, 3.5, 9)
    ctx.restore()

    const flash = Math.floor(T / 0.28) % 2 === 0
    const core = flash ? RED : AMBER
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 18)
    glow.addColorStop(0, rgba(core, 0.9))
    glow.addColorStop(0.3, rgba(core, 0.45))
    glow.addColorStop(1, rgba(core, 0))
    ctx.globalCompositeOperation = f.dark ? 'lighter' : 'source-over'
    ctx.fillStyle = glow
    ctx.fillRect(x - 18, y - 18, 36, 36)
    ctx.globalCompositeOperation = 'source-over'
    ctx.beginPath()
    ctx.arc(x, y, 4.2, 0, TAU)
    ctx.fillStyle = `rgb(${core})`
    ctx.fill()
    ctx.beginPath()
    ctx.arc(x, y, 1.8, 0, TAU)
    ctx.fillStyle = '#fff7ed'
    ctx.fill()
    ctx.restore()
  },
}
