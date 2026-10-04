/**
 * Lightning: a cloud shadow gathers and stepped leaders feel their way down,
 * then a forked bolt lands with a flash and a shockwave, leaving a scorch mark.
 */
import { runDuration, STRIKE } from '../../../lib/weather/geo'
import { STORM_SPECS } from '../../../lib/weather/types'
import { cached, rgba, smoothstep, strokeBolt, TAU, traceLoop } from './a-shared'
import type { CellArgs, Frame, KindRenderer, Pt, TrackArgs } from './types'
import { boltPoints, noise1, rng } from './util'

/** Real run length, so the scorch appears when the bolt lands. */
const RUN = runDuration('lightning', [], 0)
const STRIKE_MS = RUN * STRIKE

interface Spark {
  angle: number
  speed: number
  life: number
  size: number
}

interface Puff {
  angle: number
  dist: number
  size: number
  delay: number
}

/** One segment of the branching burn (a Lichtenberg figure), in units of the strike radius. */
interface Burn {
  x0: number
  y0: number
  x1: number
  y1: number
  depth: number
}

function lichtenberg(seed: number, level: number): Burn[] {
  return cached(`lightning:burn:${seed}:${level}`, () => {
    const r = rng(seed ^ 0x11c4)
    const out: Burn[] = []
    const grow = (x: number, y: number, ang: number, len: number, depth: number) => {
      const steps = 3 + Math.floor(r() * 3)
      for (let i = 0; i < steps; i++) {
        ang += (r() - 0.5) * 0.7
        const nx = x + (Math.cos(ang) * len) / steps
        const ny = y + (Math.sin(ang) * len) / steps
        out.push({ x0: x, y0: y, x1: nx, y1: ny, depth })
        if (depth < 4 && i < steps - 1 && r() < 0.28) grow(nx, ny, ang + (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.5), len * 0.45, depth + 1)
        x = nx
        y = ny
      }
      if (depth < 4 && len > 0.12) {
        const spread = 0.35 + r() * 0.45
        grow(x, y, ang - spread, len * (0.55 + r() * 0.2), depth + 1)
        if (r() < 0.8) grow(x, y, ang + spread, len * (0.5 + r() * 0.2), depth + 1)
      }
    }
    const arms = 6 + Math.floor(r() * 3) + level
    for (let i = 0; i < arms; i++) {
      const ang = (i / arms) * TAU + (r() - 0.5) * 0.5
      grow(Math.cos(ang) * 0.08, Math.sin(ang) * 0.08, ang, 0.32 + r() * 0.22, 0)
    }
    return out
  })
}

/** Size of the strike in px: the spec radius at this zoom, or what the canvas passed. */
function sizeOf(f: Frame, level: number, fallback: number): number {
  const spec = STORM_SPECS.lightning.radius
  const m = spec[Math.max(0, Math.min(spec.length - 1, level))]
  const px = m * f.pxPerMeter
  return px > 1 ? px : Math.max(fallback, 8)
}

/**
 * The bolt's main channel and forks, from `drop` px above the strike point down
 * to it. Relative to the strike point, so panning the map reuses it.
 */
function channel(seed: number, drop: number) {
  return cached(`lightning:bolt:${seed}:${drop}`, () => {
    const r = rng(seed ^ 0x1197)
    const top = -drop
    const side = r() < 0.5 ? -1 : 1
    const origin = { x: side * drop * (0.18 + r() * 0.22), y: top }
    const main = boltPoints(origin, { x: 0, y: 0 }, r, 0.18, 7)
    const forks: Pt[][] = []
    const leaders: Pt[][] = []
    const n = 7 + Math.floor(r() * 4)
    for (let i = 0; i < n; i++) {
      const at = Math.floor((0.08 + r() * 0.72) * (main.length - 1))
      const from = main[at]
      const left = drop - (from.y - top)
      const ang = Math.PI / 2 + (r() - 0.5) * 1.9
      const len = Math.max(20, left * (0.18 + r() * 0.32))
      const fork = boltPoints(from, { x: from.x + Math.cos(ang) * len, y: from.y + Math.sin(ang) * len }, r, 0.3, 5)
      forks.push(fork)
      if (r() < 0.45) {
        const sub = fork[Math.floor(fork.length * (0.3 + r() * 0.4))]
        const sa = ang + (r() - 0.5) * 1.4
        const sl = len * (0.3 + r() * 0.3)
        forks.push(boltPoints(sub, { x: sub.x + Math.cos(sa) * sl, y: sub.y + Math.sin(sa) * sl }, r, 0.3, 4))
      }
      if (i < 4) leaders.push(fork)
    }
    return { main, forks, leaders, origin }
  })
}

function particles(seed: number, level: number) {
  return cached(`lightning:bits:${seed}:${level}`, () => {
    const r = rng(seed ^ 0x5a5a)
    const sparks: Spark[] = []
    for (let i = 0; i < 40 + level * 16; i++) sparks.push({ angle: r() * TAU, speed: 0.7 + r() * 2.2, life: 300 + r() * 700, size: 0.8 + r() * 1.4 })
    const puffs: Puff[] = []
    for (let i = 0; i < 9; i++) puffs.push({ angle: r() * TAU, dist: r() * 0.5, size: 0.5 + r() * 0.6, delay: r() * 220 })
    const shadow: Puff[] = []
    for (let i = 0; i < 7; i++) shadow.push({ angle: (i / 7) * TAU + r() * 0.6, dist: 0.3 + r() * 0.7, size: 0.8 + r() * 0.7, delay: r() * TAU })
    return { sparks, puffs, shadow, wind: r() * TAU }
  })
}

function stroke(ctx: CanvasPath, pts: Pt[], upto = pts.length) {
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < upto; i++) ctx.lineTo(pts[i].x, pts[i].y)
}

function track(f: Frame, a: TrackArgs) {
  if (a.swept.length === 0) return
  const since = a.live ? a.age - STRIKE_MS : a.age + (RUN - STRIKE_MS)
  if (since < 0) return
  const { ctx, dark } = f
  const R = sizeOf(f, a.level, a.radiusPx)
  const p = a.swept[a.swept.length - 1]
  const grow = smoothstep(0, 160, since)
  const heat = Math.exp(-since / 2600)
  const t = f.now / 1000

  ctx.save()
  ctx.translate(p.x, p.y)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Ash halo so the burn reads on the dark map too.
  const halo = ctx.createRadialGradient(0, 0, R * 0.4, 0, 0, R * 1.35 * grow)
  halo.addColorStop(0, rgba(dark ? '190,180,165' : '120,105,90', 0))
  halo.addColorStop(0.55, rgba(dark ? '190,180,165' : '120,105,90', dark ? 0.2 : 0.12))
  halo.addColorStop(1, rgba(dark ? '190,180,165' : '120,105,90', 0))
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(0, 0, R * 1.35 * grow, 0, TAU)
  ctx.fill()

  // The burn itself, ragged at the edge.
  const burnR = R * 0.42 * grow
  ctx.beginPath()
  for (let i = 0; i < 28; i++) {
    const th = (i / 28) * TAU
    const rr = burnR * (0.8 + 0.4 * noise1(i * 0.7, a.seed))
    if (i) ctx.lineTo(Math.cos(th) * rr, Math.sin(th) * rr)
    else ctx.moveTo(Math.cos(th) * rr, Math.sin(th) * rr)
  }
  ctx.closePath()
  const burn = ctx.createRadialGradient(0, 0, 0, 0, 0, burnR * 1.2)
  burn.addColorStop(0, rgba('12,9,7', 0.78))
  burn.addColorStop(0.55, rgba('26,18,13', 0.55))
  burn.addColorStop(1, rgba('40,30,22', 0.05))
  ctx.fillStyle = burn
  ctx.fill()

  // Branching burn fanning out through the grass, glowing while hot and cooling to dark.
  const cool = 1 - heat
  const burns = lichtenberg(a.seed, a.level)
  const tiers = [new Path2D(), new Path2D(), new Path2D()]
  const reach = R * 1.15 * grow
  for (const b of burns) {
    const tier = tiers[Math.min(2, b.depth)]
    tier.moveTo(b.x0 * reach, b.y0 * reach)
    tier.lineTo(b.x1 * reach, b.y1 * reach)
  }
  const hotRgb = dark
    ? `${Math.round(255 - 95 * cool)},${Math.round(160 - 20 * cool)},${Math.round(70 + 50 * cool)}`
    : `${Math.round(255 - 215 * cool)},${Math.round(140 - 110 * cool)},${Math.round(50 - 30 * cool)}`
  if (heat > 0.05) {
    ctx.shadowColor = `rgba(255,120,40,${heat})`
    ctx.shadowBlur = 5 * heat
  }
  const w = Math.max(0.6, R * 0.022)
  for (let i = 0; i < 3; i++) {
    ctx.lineWidth = w * [2.1, 1.3, 0.75][i]
    ctx.strokeStyle = rgba(hotRgb, (dark ? 0.75 : 0.7) * [1, 0.8, 0.6][i] * (0.6 + 0.4 * heat))
    ctx.stroke(tiers[i])
  }
  ctx.shadowBlur = 0

  // Ember glow at the centre, breathing as it cools.
  const breathe = 0.85 + 0.15 * noise1(t * 3, a.seed)
  const ember = Math.max(heat, dark ? 0.2 : 0.12) * breathe
  const eg = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.55)
  eg.addColorStop(0, rgba('255,214,140', 0.75 * ember))
  eg.addColorStop(0.3, rgba('255,120,40', 0.5 * ember))
  eg.addColorStop(1, rgba('200,50,20', 0))
  if (dark) ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = eg
  ctx.beginPath()
  ctx.arc(0, 0, R * 0.55, 0, TAU)
  ctx.fill()
  ctx.restore()
}

function cell(f: Frame, a: CellArgs) {
  const { ctx, dark, width, height } = f
  const k = a.intensity
  if (k <= 0) return
  const R = sizeOf(f, a.level, a.radiusPx)
  const lv = Math.max(0, Math.min(2, a.level))
  const head = a.head
  const total = a.progress > 0 ? a.elapsed / a.progress : RUN
  const dt = a.elapsed - STRIKE * total
  const t = f.now / 1000
  const seed = a.seed
  // Tall enough that the bolt always enters from above the top of the view; bucketed so it stays put.
  const bolt = channel(seed, Math.max(320, Math.ceil((head.y + 60) / 80) * 80))
  const { sparks, puffs, shadow, wind } = particles(seed, lv)
  const scale = 1 + lv * 0.25

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Storm cloud shadow gathering overhead, darkest just before the strike.
  const gather = dt < 0 ? smoothstep(0, 1, a.progress / STRIKE) : Math.max(0, 1 - dt / (total * 0.45))
  if (gather > 0.01) {
    const shade = dark ? '2,4,14' : '28,32,52'
    for (const s of shadow) {
      const th = s.angle + t * 0.25
      const rad = R * (1.2 + 1.6 * gather) * s.dist
      const x = head.x + Math.cos(th) * rad
      const y = head.y + Math.sin(th) * rad
      const size = R * (1.5 + 1.8 * gather) * s.size
      const g = ctx.createRadialGradient(x, y, 0, x, y, size)
      g.addColorStop(0, rgba(shade, (dark ? 0.42 : 0.2) * gather * k))
      g.addColorStop(0.6, rgba(shade, (dark ? 0.22 : 0.1) * gather * k))
      g.addColorStop(1, rgba(shade, 0))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, size, 0, TAU)
      ctx.fill()
    }
    // Ragged cloud base: nested layers, the outer one faintly lit at its edge.
    for (let layer = 0; layer < 3; layer++) {
      const xs: number[] = []
      const ys: number[] = []
      const base = R * (2.1 + 1.9 * gather) * (1 - layer * 0.24)
      for (let i = 0; i < 48; i++) {
        const th = (i / 48) * TAU
        const rr = base * (0.78 + 0.34 * noise1(i * 0.45 + t * 0.35 + layer * 7, seed + 9) + 0.12 * noise1(i * 1.3 - t * 0.6, seed + 4 + layer))
        xs.push(head.x + Math.cos(th + t * 0.05) * rr)
        ys.push(head.y + Math.sin(th + t * 0.05) * rr)
      }
      ctx.beginPath()
      traceLoop(ctx, xs, ys)
      ctx.fillStyle = rgba(shade, (dark ? 0.13 : 0.06) * gather * k)
      ctx.fill()
      if (layer === 0) {
        ctx.lineWidth = 5
        ctx.strokeStyle = dark ? rgba('150,165,230', 0.06 * gather * k) : rgba('40,50,110', 0.05 * gather * k)
        ctx.stroke()
        ctx.lineWidth = 1
        ctx.strokeStyle = dark ? rgba('170,185,240', 0.16 * gather * k) : rgba('40,50,110', 0.14 * gather * k)
        ctx.stroke()
      }
    }
    // Sheet lightning flickering inside the cloud.
    if (dt < 0 && gather > 0.35) {
      const slot = Math.floor(f.now / 90)
      const fr = rng((seed ^ Math.imul(slot, 0x2c1b3c6d)) >>> 0)
      if (fr() < 0.3) {
        const x = head.x + (fr() - 0.5) * R * 3
        const y = head.y + (fr() - 0.5) * R * 3
        const g = ctx.createRadialGradient(x, y, 0, x, y, R * 2.2)
        g.addColorStop(0, rgba('190,200,255', 0.22 * gather * k))
        g.addColorStop(1, rgba('190,200,255', 0))
        ctx.save()
        if (dark) ctx.globalCompositeOperation = 'lighter'
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(x, y, R * 2.2, 0, TAU)
        ctx.fill()
        ctx.restore()
      }
    }
  }

  if (dt < 0) {
    // Stepped leaders: the channel feels its way down in flickering steps.
    const lead = smoothstep(0.3, 1, a.progress / STRIKE)
    if (lead > 0) {
      const step = Math.floor(f.now / 55)
      const flick = 0.45 + 0.55 * rng((seed ^ Math.imul(step, 0x45d9f3b)) >>> 0)()
      const reach = bolt.main[0].y * (1 - lead)
      const path = new Path2D()
      let upto = 0
      while (upto < bolt.main.length && bolt.main[upto].y <= reach) upto++
      if (upto > 1) {
        path.moveTo(bolt.main[0].x, bolt.main[0].y)
        for (let i = 1; i < upto; i++) path.lineTo(bolt.main[i].x, bolt.main[i].y)
      }
      for (const l of bolt.leaders) {
        let n = 0
        while (n < l.length && l[n].y <= reach) n++
        if (n > 1) {
          path.moveTo(l[0].x, l[0].y)
          for (let i = 1; i < n; i++) path.lineTo(l[i].x, l[i].y)
        }
      }
      ctx.save()
      ctx.translate(head.x, head.y)
      if (dark) ctx.globalCompositeOperation = 'lighter'
      ctx.strokeStyle = dark ? rgba('150,170,255', 0.22 * flick * k) : rgba('70,80,200', 0.25 * flick * k)
      ctx.lineWidth = 4
      ctx.stroke(path)
      ctx.strokeStyle = dark ? rgba('225,230,255', 0.65 * flick * k) : rgba('60,60,170', 0.6 * flick * k)
      ctx.lineWidth = 1.1
      ctx.stroke(path)
      ctx.restore()

      // Streamers reaching up from the ground and a charge glow at the target.
      const charge = smoothstep(0.6, 1, lead)
      if (charge > 0) {
        const sr = rng((seed ^ Math.imul(step, 0x27d4eb2d)) >>> 0)
        const streamers = new Path2D()
        for (let i = 0; i < 3; i++) {
          const ang = -Math.PI / 2 + (sr() - 0.5) * 1.6
          const len = R * (0.3 + sr() * 0.6) * charge
          const pts = boltPoints(head, { x: head.x + Math.cos(ang) * len, y: head.y + Math.sin(ang) * len }, sr, 0.35, 3)
          stroke(streamers, pts)
        }
        ctx.save()
        if (dark) ctx.globalCompositeOperation = 'lighter'
        ctx.strokeStyle = dark ? rgba('210,220,255', 0.7 * charge * k) : rgba('70,70,190', 0.7 * charge * k)
        ctx.lineWidth = 1
        ctx.stroke(streamers)
        const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, R * 0.7)
        g.addColorStop(0, rgba(dark ? '200,210,255' : '110,120,255', 0.45 * charge * flick * k))
        g.addColorStop(1, rgba(dark ? '200,210,255' : '110,120,255', 0))
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(head.x, head.y, R * 0.7, 0, TAU)
        ctx.fill()
        ctx.restore()
      }
    }
    ctx.restore()
    return
  }

  // The flash: the whole view lights up and decays in a couple hundred ms, with a restrike.
  const flash = 0.62 * Math.exp(-dt / 70) + 0.22 * Math.exp(-(((dt - 130) / 28) ** 2))
  if (flash > 0.005) {
    ctx.save()
    ctx.fillStyle = dark ? rgba('225,232,255', flash * 0.75 * k) : rgba('236,240,255', flash * 0.5 * k)
    ctx.fillRect(0, 0, width, height)
    ctx.restore()
  }

  // The bolt, flickering through its return strokes.
  const env = dt < 50 ? 1 : dt < 85 ? 0.3 : dt < 150 ? 0.95 : dt < 180 ? 0.35 : dt < 240 ? 0.8 : Math.max(0, 1 - (dt - 240) / 260) * 0.7
  if (env > 0.01) {
    ctx.save()
    ctx.translate(head.x, head.y)
    strokeBolt(ctx, bolt.main, bolt.forks, dark, env * k, 1.35 * scale)
    // A second, wider halo pass on the main channel for the blinding first stroke.
    if (dt < 160) {
      ctx.save()
      if (dark) ctx.globalCompositeOperation = 'lighter'
      ctx.beginPath()
      stroke(ctx, bolt.main)
      ctx.strokeStyle = dark ? rgba('140,170,255', 0.16 * env * k) : rgba('80,100,230', 0.18 * env * k)
      ctx.lineWidth = 22 * scale
      ctx.stroke()
      ctx.restore()
    }
    ctx.restore()
  }

  // Ground strike: a white-hot point that cools through yellow to orange.
  const hot = Math.exp(-dt / 380)
  ctx.save()
  if (dark) ctx.globalCompositeOperation = 'lighter'
  const gr = R * (1.1 + dt / 700)
  const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, gr)
  g.addColorStop(0, rgba('255,255,255', 0.95 * hot * k))
  g.addColorStop(0.18, rgba('255,236,160', 0.8 * hot * k))
  g.addColorStop(0.45, rgba('255,150,60', 0.4 * hot * k))
  g.addColorStop(1, rgba('255,90,30', 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(head.x, head.y, gr, 0, TAU)
  ctx.fill()
  ctx.restore()

  // Shockwave rings racing out from the strike.
  for (let ring = 0; ring < 2; ring++) {
    const rt = dt - ring * 90
    if (rt < 0) continue
    const q = Math.min(1, rt / 750)
    if (q >= 1) continue
    const rad = R * (0.3 + 3.2 * (1 - Math.pow(1 - q, 3)))
    ctx.beginPath()
    ctx.arc(head.x, head.y, rad, 0, TAU)
    ctx.lineWidth = (ring === 0 ? 3.2 : 1.6) * (1 - q) + 0.4
    ctx.strokeStyle = dark ? rgba('215,228,255', (ring === 0 ? 0.75 : 0.45) * (1 - q) * k) : rgba('50,70,170', (ring === 0 ? 0.7 : 0.4) * (1 - q) * k)
    ctx.stroke()
  }

  // Sparks thrown out from the strike, trailing and cooling.
  const bits = [new Path2D(), new Path2D(), new Path2D()]
  for (const s of sparks) {
    if (dt > s.life) continue
    const tau = 240
    const reachAt = (ms: number) => s.speed * R * (1 - Math.exp(-ms / tau))
    const d1 = reachAt(dt)
    const d0 = reachAt(Math.max(0, dt - 40))
    const c = Math.cos(s.angle)
    const sn = Math.sin(s.angle)
    const sag = (dt / 1000) ** 2 * R * 0.8
    const target = bits[Math.min(2, Math.floor((dt / s.life) * 3))]
    target.moveTo(head.x + c * d0, head.y + sn * d0 + sag * 0.6)
    target.lineTo(head.x + c * d1, head.y + sn * d1 + sag)
  }
  ctx.save()
  if (dark) ctx.globalCompositeOperation = 'lighter'
  const sparkRgb = dark ? ['255,244,200', '255,180,90', '255,110,50'] : ['255,170,40', '230,110,20', '190,70,20']
  for (let i = 0; i < 3; i++) {
    ctx.lineWidth = [1.6, 1.25, 0.9][i]
    ctx.strokeStyle = rgba(sparkRgb[i], [0.95, 0.75, 0.45][i] * k)
    ctx.stroke(bits[i])
  }
  ctx.restore()

  // Smoke drifting off downwind.
  const smoke = dark ? '160,160,168' : '80,80,88'
  for (const p of puffs) {
    const pt = dt - 80 - p.delay
    if (pt < 0) continue
    const life = Math.min(1, pt / (total * 0.6))
    const drift = R * (0.4 + 1.8 * life)
    const x = head.x + Math.cos(wind) * drift + Math.cos(p.angle) * R * p.dist
    const y = head.y + Math.sin(wind) * drift + Math.sin(p.angle) * R * p.dist
    const size = R * (0.35 + 1.0 * life) * p.size + 2
    const alpha = (dark ? 0.22 : 0.2) * Math.sin(Math.PI * Math.min(1, life * 1.1 + 0.05)) * k
    const sg = ctx.createRadialGradient(x, y, 0, x, y, size)
    sg.addColorStop(0, rgba(smoke, alpha))
    sg.addColorStop(1, rgba(smoke, 0))
    ctx.fillStyle = sg
    ctx.beginPath()
    ctx.arc(x, y, size, 0, TAU)
    ctx.fill()
  }

  // Afterglow at the point of impact.
  const after = Math.max(0, 1 - dt / (total * 0.7))
  if (after > 0) {
    ctx.save()
    if (dark) ctx.globalCompositeOperation = 'lighter'
    const flick = 0.75 + 0.25 * noise1(t * 9, seed)
    const ag = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, R * 0.6)
    ag.addColorStop(0, rgba('255,200,120', 0.5 * after * flick * k))
    ag.addColorStop(1, rgba('255,120,40', 0))
    ctx.fillStyle = ag
    ctx.beginPath()
    ctx.arc(head.x, head.y, R * 0.6, 0, TAU)
    ctx.fill()
    ctx.restore()
  }
  ctx.restore()
}

export const lightning: KindRenderer = { track, cell }
