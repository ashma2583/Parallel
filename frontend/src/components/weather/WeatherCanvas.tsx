/**
 * Draws weather on the map: campus-wide conditions, storms on record, the
 * planned storms waiting in the scenario, the ones running now and the hits
 * they land, the path being drawn, the ghost under the cursor, and lasting
 * marks. One canvas sits right above MapLibre's own, under its markers; the text
 * labels go on a second one above the line overlays and markers, so nothing
 * strikes through them.
 */
import { useEffect, useRef } from 'react'
import type { Map as MaplibreMap } from 'maplibre-gl'
import { cumulative, growRadius, headFraction, pathLength, pointAt, slicePath, TOUCHDOWN } from '../../lib/weather/geo'
import { stormLabel } from '../../lib/weather/impacts'
import {
  simClock,
  STORM_SPECS,
  type CampusEffect,
  type DraftStorm,
  type HoverStorm,
  type Impact,
  type LiveStorm,
  type LngLat,
  type MapMark,
  type StagedStorm,
  type StormKind,
  type WeatherCanvasProps,
} from '../../lib/weather/types'
import { RENDERERS } from './render'
import { CAMPUS } from './render/campus'
import type { CellArgs, Frame, Pt, TrackArgs } from './render/types'
import { boltPoints, clamp01, hash, rng, tracePath } from './render/util'

const TAU = Math.PI * 2
/** How long a hit's ring and flash run, and how long its label stays up. */
const BURST = 1400
const LABEL = 2300
const MAX_LABELS = 5
/** A campus-wide condition settles to this after it arrives, over SETTLE ms. */
const LINGER = 0.35
const SETTLE = 900
const SANS = '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif'
const DEFAULT_STARTS_AT = '14:00'
const MONO = '"IBM Plex Mono", ui-monospace, monospace'

export function WeatherCanvas(props: WeatherCanvasProps) {
  const { map } = props
  const latest = useRef(props)
  const painter = useRef<Painter | null>(null)

  useEffect(() => {
    latest.current = props
    painter.current?.wake()
  })

  useEffect(() => {
    if (!map) return
    const next = createPainter(map, () => latest.current)
    painter.current = next
    return () => {
      next.destroy()
      painter.current = null
    }
  }, [map])

  return null
}

interface Painter {
  wake(): void
  destroy(): void
}

type RGB = [number, number, number]

interface Palette {
  dark: boolean
  pill: string
  pillEdge: string
  text: string
  muted: string
  leader: string
  shadow: string
  down: RGB
  warn: RGB
  spark: RGB
  sparkCore: string
  centre: string
}

const DARK: Palette = {
  dark: true,
  pill: 'rgba(15,18,23,0.92)',
  pillEdge: 'rgba(255,255,255,0.10)',
  text: '#ece9e2',
  muted: '#8f95a1',
  leader: 'rgba(236,233,226,0.45)',
  shadow: 'rgba(0,0,0,0.45)',
  down: [255, 93, 93],
  warn: [255, 138, 61],
  spark: [250, 204, 21],
  sparkCore: '#fffbe6',
  centre: 'rgba(255,255,255,0.78)',
}

const LIGHT: Palette = {
  dark: false,
  pill: 'rgba(251,251,249,0.95)',
  pillEdge: 'rgba(18,21,26,0.12)',
  text: '#12151a',
  muted: '#5a616d',
  leader: 'rgba(18,21,26,0.4)',
  shadow: 'rgba(18,21,26,0.22)',
  down: [217, 58, 58],
  warn: [217, 101, 13],
  spark: [202, 138, 4],
  sparkCore: '#fff7d1',
  centre: 'rgba(18,21,26,0.72)',
}

const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

function hexRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Accents are pale, made for the dark map. The light map gets the same hue, darker (matches the dock). */
const ON_LIGHT: Record<StormKind, string> = {
  tornado: '#7a6450',
  thunderstorm: '#0d8a80',
  ice: '#0284c7',
  flood: '#2563eb',
  blizzard: '#475569',
  lightning: '#a37f00',
  blackout: '#4f5bd5',
  closure: '#be3455',
}

const ACCENTS = new Map<string, RGB>()
function accentOf(kind: StormKind, dark: boolean): RGB {
  const key = `${kind}:${dark}`
  let c = ACCENTS.get(key)
  if (!c) {
    c = hexRgb(dark ? STORM_SPECS[kind].accent : ON_LIGHT[kind])
    ACCENTS.set(key, c)
  }
  return c
}

const easeOut = (t: number) => 1 - (1 - t) ** 3
const easeBack = (t: number) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2

function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`
}

/**
 * A flat drawing space laid on the ground under one storm when the map is tilted.
 * Flat units are screen pixels where the storm sits, so a round footprint drawn
 * there lands foreshortened like the map under it. Unused when the map is flat.
 */
interface Ground {
  /** Flat to screen, as canvas transform(a, b, c, d, e, f). */
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
  /** Screen to flat: the inverse of a, b, c, d, then minus the offset. */
  ia: number
  ib: number
  ic: number
  id: number
  ox: number
  oy: number
  /** Flat pixels per meter. */
  s: number
  /** The flat box that covers the screen, from 0,0. */
  w: number
  h: number
}

type Flat = (p: Pt) => Pt
const same: Flat = (p) => p

function createPainter(map: MaplibreMap, read: () => WeatherCanvasProps): Painter {
  const host = map.getContainer()
  const el = document.createElement('canvas')
  el.setAttribute('aria-hidden', 'true')
  el.dataset.layer = 'weather'
  el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
  map.getCanvasContainer().insertBefore(el, map.getCanvas().nextSibling)
  const over = document.createElement('canvas')
  over.setAttribute('aria-hidden', 'true')
  over.dataset.layer = 'weather-labels'
  // Above the bus and power line overlays (z 1), below MapLibre's controls (z 2, later in the page).
  over.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2'
  host.insertBefore(over, host.querySelector(':scope > .maplibregl-control-container'))
  const ctx = el.getContext('2d')
  const lctx = over.getContext('2d')
  if (!ctx || !lctx) {
    return {
      wake() {},
      destroy: () => {
        el.remove()
        over.remove()
      },
    }
  }

  let width = 0
  let height = 0
  let dpr = 1
  let raf = 0
  let last = 0
  let dirty = true
  let painted = false
  let alive = true

  const seen = new Map<string, number>()
  const widths = new Map<string, number>()
  const sprites = new Map<string, HTMLCanvasElement>()
  const placed: { x: number; y: number; w: number; h: number }[] = []
  let layer: HTMLCanvasElement | null = null
  /** The ground space of the storm being drawn, while one is. */
  let ground: Ground | null = null
  const cums = new WeakMap<readonly LngLat[], number[]>()
  const cumOf = (path: readonly LngLat[]) => {
    let c = cums.get(path)
    if (!c) {
      c = cumulative(path)
      cums.set(path, c)
    }
    return c
  }

  const media = window.matchMedia('(prefers-color-scheme: light)')
  const isDark = () => {
    const theme = document.documentElement.getAttribute('data-theme')
    if (theme === 'dark') return true
    if (theme === 'light') return false
    return !media.matches
  }

  const project = (p: LngLat): Pt => map.project(p)
  const projectAll = (path: readonly LngLat[]): Pt[] => {
    const out = new Array<Pt>(path.length)
    for (let i = 0; i < path.length; i++) out[i] = map.project(path[i])
    return out
  }

  const measure = (font: string, text: string) => {
    const key = font + text
    let w = widths.get(key)
    if (w === undefined) {
      ctx.font = font
      w = ctx.measureText(text).width
      widths.set(key, w)
    }
    return w
  }

  const resize = () => {
    width = host.clientWidth
    height = host.clientHeight
    dpr = window.devicePixelRatio || 1
    el.width = Math.max(1, Math.round(width * dpr))
    el.height = Math.max(1, Math.round(height * dpr))
    over.width = el.width
    over.height = el.height
    if (layer) {
      layer.width = el.width
      layer.height = el.height
    }
    painted = false
    wake()
  }

  const clear = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, el.width, el.height)
    lctx.setTransform(1, 0, 0, 1, 0, 0)
    lctx.clearRect(0, 0, over.width, over.height)
    painted = false
  }

  /** On screen, give or take a margin. */
  const near = (x: number, y: number, pad: number) => x > -pad && y > -pad && x < width + pad && y < height + pad

  const boundsNear = (pts: readonly Pt[], pad: number) => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const p of pts) {
      if (p.x < x0) x0 = p.x
      if (p.x > x1) x1 = p.x
      if (p.y < y0) y0 = p.y
      if (p.y > y1) y1 = p.y
    }
    return x1 > -pad && y1 > -pad && x0 < width + pad && y0 < height + pad
  }

  function tick() {
    raf = 0
    if (!alive) return
    const p = read()
    if (p.hidden) {
      if (painted) clear()
      dirty = false
      return
    }
    const now = performance.now()
    const live = p.live ?? []
    const staged = p.staged ?? []
    const campus = p.campus ?? []
    const liveIds = new Set(live.map((l) => l.storm.id))
    // Every frame: storms moving, a condition arriving or settling, the path being drawn, the cursor ghost.
    const animated = live.length > 0 || Boolean(p.draft || p.hover) || campus.some((c) => now - c.startedAt < c.duration + SETTLE)
    // About 30 fps: ambient motion on finished tracks, lingering conditions, the selected ghost's marching dashes.
    const ambient =
      campus.length > 0 || p.tracks.some((t) => !liveIds.has(t.id)) || (p.selectedId !== null && staged.some((g) => g.id === p.selectedId))
    // Only when something changes: marks and unselected ghosts hold still.
    const still = p.marks.length > 0 || staged.length > 0
    if (!animated && !ambient && !still) {
      if (painted) clear()
      dirty = false
      return
    }
    if (animated || dirty || (ambient && now - last >= 33)) {
      draw(p, now)
      last = now
      dirty = false
    }
    if (animated || ambient) raf = requestAnimationFrame(tick)
  }

  function wake() {
    dirty = true
    if (!raf && alive) raf = requestAnimationFrame(tick)
  }

  function draw(p: WeatherCanvasProps, now: number) {
    if (!ctx || !lctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    lctx.clearRect(0, 0, width, height)
    painted = true
    // The 3D basemap is light in either theme, so the weather on it uses the light palette.
    const dark = isDark() && !p.lightMap
    const pal = dark ? DARK : LIGHT
    const c = map.getCenter()
    const a = map.project([c.lng, c.lat])
    const b = map.project([c.lng + 100 / (Math.cos((c.lat * Math.PI) / 180) * 111_320), c.lat])
    const pxPerMeter = Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y) / 100)
    const f: Frame = { ctx, width, height, now, dark, pxPerMeter }
    const lives = p.live ?? []
    const liveIds = new Set(lives.map((l) => l.storm.id))

    for (const c of p.campus ?? []) drawCampus(f, c)

    for (const t of p.tracks) {
      if (liveIds.has(t.id) || t.path.length === 0) continue
      let born = seen.get(t.id)
      if (born === undefined) {
        born = now
        seen.set(t.id, now)
      }
      const path = projectAll(t.path)
      if (!boundsNear(path, t.radius * pxPerMeter * 1.6 + 40)) continue
      onGround(f, middle(t.path), (g, flat) => {
        const pts = path.map(flat)
        RENDERERS[t.kind].track(g, { kind: t.kind, level: t.level, path: pts, swept: pts, radiusPx: t.radius * g.pxPerMeter, live: false, seed: hash(t.id), age: now - born })
      })
    }

    drawGhosts(f, p.staged ?? [], p.selectedId, pal, p.startsAt ?? DEFAULT_STARTS_AT)

    const runs = lives.flatMap((live) => {
      const state = liveState(now, live)
      return state ? [state] : []
    })
    for (const st of runs) {
      onGround(f, middle(st.live.storm.path), (g, flat) => RENDERERS[st.live.storm.kind].track(g, liveTrack(st, g, flat)))
    }
    drawMarks(p.marks, pal)
    for (const st of runs) {
      if (st.progress >= 1) continue
      onGround(f, st.head, (g, flat) => RENDERERS[st.live.storm.kind].cell(g, liveCell(st, g, flat)))
    }
    if (lives.length > 0) drawHits(lives, now, pal)
    if (p.draft) drawDraft(f, p.draft, pal)
    if (p.hover && !p.draft) drawHover(f, p.hover, pal)
  }

  // -------------------------------------------------------------------------
  // The ground under a storm, when the map is tilted.
  // -------------------------------------------------------------------------

  /** Halfway along a path, or its only point. */
  function middle(path: readonly LngLat[]): LngLat {
    if (path.length < 2) return path[0]
    const cum = cumOf(path)
    return pointAt(path, cum[cum.length - 1] / 2, cum)
  }

  /** The ground space at a point, or null when the map is flat and screen pixels already are ground. */
  function groundAt(anchor: LngLat): Ground | null {
    if (map.getPitch() < 1) return null
    const at = map.project(anchor)
    const mx = Math.cos((anchor[1] * Math.PI) / 180) * 111_320
    const my = 110_540
    // The ground direction that runs left to right on screen here, and the scale along it.
    const right = map.unproject([at.x + 40, at.y])
    const vx = (right.lng - anchor[0]) * mx
    const vy = (right.lat - anchor[1]) * my
    const len = Math.hypot(vx, vy)
    if (!(len > 0.01)) return null
    const s = 40 / len
    const e1x = vx / len
    const e1y = vy / len
    // A flat step down the screen is this way on the ground.
    const e2x = e1y
    const e2y = -e1x
    const step = 40 / s
    const screenOf = (gx: number, gy: number) => {
      const q = map.project([anchor[0] + gx / mx, anchor[1] + gy / my])
      return [(q.x - at.x) / 40, (q.y - at.y) / 40]
    }
    const [a, c1] = screenOf(e1x * step, e1y * step)
    const [b, d] = screenOf(e2x * step, e2y * step)
    const det = a * d - b * c1
    if (!(Math.abs(det) > 0.02)) return null
    const ia = d / det
    const ib = -b / det
    const ic = -c1 / det
    const id = a / det
    // The screen's corners in flat space, so renderers that cull to the view still see all of it.
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [x, y] of [[0, 0], [width, 0], [0, height], [width, height]]) {
      const fx = ia * x + ib * y
      const fy = ic * x + id * y
      x0 = Math.min(x0, fx)
      x1 = Math.max(x1, fx)
      y0 = Math.min(y0, fy)
      y1 = Math.max(y1, fy)
    }
    return { a, b: c1, c: b, d, e: a * x0 + b * y0, f: c1 * x0 + d * y0, ia, ib, ic, id, ox: x0, oy: y0, s, w: x1 - x0, h: y1 - y0 }
  }

  /**
   * Draw one storm on the ground at `anchor`. The callback gets the frame to paint
   * with and a function that takes a projected point into its space.
   */
  function onGround(f: Frame, anchor: LngLat, paint: (g: Frame, flat: Flat, rise: (p: Pt) => Pt) => void) {
    if (!ctx) return
    const g = groundAt(anchor)
    ctx.save()
    if (!g) {
      paint(f, same, same)
      ctx.restore()
      return
    }
    ctx.transform(g.a, g.b, g.c, g.d, g.e, g.f)
    ground = g
    try {
      paint(
        { ...f, pxPerMeter: g.s, width: g.w, height: g.h },
        (p) => ({ x: g.ia * p.x + g.ib * p.y - g.ox, y: g.ic * p.x + g.id * p.y - g.oy }),
        (q) => ({ x: g.a * q.x + g.c * q.y + g.e, y: g.b * q.x + g.d * q.y + g.f }),
      )
    } finally {
      ground = null
      ctx.restore()
    }
  }

  // -------------------------------------------------------------------------
  // Storms running now.
  // -------------------------------------------------------------------------

  interface LiveState {
    live: LiveStorm
    progress: number
    elapsed: number
    seed: number
    /** Where the storm centre is now. */
    head: LngLat
    along: number
    /** Running length along a moving storm's path; null for one that stays put. */
    cum: number[] | null
    total: number
  }

  function liveState(now: number, live: LiveStorm): LiveState | null {
    const s = live.storm
    if (s.path.length === 0) return null
    const elapsed = now - live.startedAt
    const progress = clamp01(elapsed / Math.max(1, live.duration))
    const seed = hash(s.id)
    if (s.path.length < 2 || s.kind === 'lightning') return { live, progress, elapsed, seed, head: s.path[0], along: 0, cum: null, total: 0 }
    const cum = cumOf(s.path)
    const total = cum[cum.length - 1]
    const along = headFraction(progress) * total
    return { live, progress, elapsed, seed, head: pointAt(s.path, along, cum), along, cum, total }
  }

  /** What the storm has swept so far. */
  function liveTrack(st: LiveState, f: Frame, flat: Flat): TrackArgs {
    const s = st.live.storm
    const base = { kind: s.kind, level: s.level, seed: st.seed, live: true, age: st.elapsed }
    if (!st.cum) {
      const head = flat(project(s.path[0]))
      return { ...base, path: [head], swept: [head], radiusPx: growRadius(s.radius, st.progress) * f.pxPerMeter }
    }
    const path = projectAll(s.path).map(flat)
    return { ...base, path, swept: projectAll(slicePath(s.path, st.along, st.cum)).map(flat), radiusPx: s.radius * f.pxPerMeter }
  }

  /** The storm itself, where it is now. */
  function liveCell(st: LiveState, f: Frame, flat: Flat): CellArgs {
    const s = st.live.storm
    const base = { kind: s.kind, level: s.level, seed: st.seed, progress: st.progress, elapsed: st.elapsed }
    if (!st.cum) {
      const head = flat(project(s.path[0]))
      const intensity = clamp01(Math.min(1, st.progress / 0.1, (1 - st.progress) / 0.15))
      return { ...base, head, heading: 0, stationary: true, radiusPx: growRadius(s.radius, st.progress) * f.pxPerMeter, intensity, path: [head] }
    }
    const head = flat(project(st.head))
    const ahead = flat(project(pointAt(s.path, Math.min(st.total, st.along + 8), st.cum)))
    const behind = flat(project(pointAt(s.path, Math.max(0, st.along - 8), st.cum)))
    const intensity = clamp01(Math.min(1, st.progress / TOUCHDOWN, (1 - st.progress) / 0.08))
    return {
      ...base,
      head,
      heading: Math.atan2(ahead.y - behind.y, ahead.x - behind.x),
      stationary: false,
      radiusPx: s.radius * f.pxPerMeter * (0.7 + 0.3 * intensity),
      intensity,
      path: projectAll(s.path).map(flat),
    }
  }

  // -------------------------------------------------------------------------
  // Hits: a flash and ring where something just went down, and a label.
  // -------------------------------------------------------------------------

  /** A campus-wide condition: strong while it arrives, then a faint lingering level. */
  function drawCampus(f: Frame, c: CampusEffect) {
    if (!ctx) return
    const elapsed = f.now - c.startedAt
    if (elapsed < 0) return
    const duration = Math.max(1, c.duration)
    const settle = easeOut(clamp01((elapsed - duration) / SETTLE))
    ctx.save()
    CAMPUS[c.hazard].draw(f, {
      hazard: c.hazard,
      progress: clamp01(elapsed / duration),
      intensity: 1 - (1 - LINGER) * settle,
      elapsed,
      seed: hash(c.id),
    })
    ctx.restore()
  }

  function drawHits(lives: readonly LiveStorm[], now: number, pal: Palette) {
    if (!ctx) return
    placed.length = 0
    const labels: { impact: Impact; x: number; y: number; age: number }[] = []
    for (const live of lives) for (const impact of live.impacts) {
      // Graph roads are hidden on the map by default. Their closures are in the feed, not on screen.
      if (impact.target === 'road') continue
      const age = now - (live.startedAt + impact.t * live.duration)
      if (age < 0 || age > LABEL) continue
      const at = project(impact.at)
      if (!near(at.x, at.y, 80)) continue
      if (age < BURST) {
        ctx.save()
        const seed = hash(impact.key)
        if (impact.target === 'line') burstLine(at.x, at.y, age, pal, seed)
        else if (impact.target === 'bus') burstClose(at.x, at.y, age, pal)
        else if (impact.action === 'derate') burstDerate(at.x, at.y, age, pal)
        else burstBuilding(at.x, at.y, age, pal, seed)
        ctx.restore()
      }
      labels.push({ impact, x: at.x, y: at.y, age })
    }
    // Buildings and feeds win the space, then lines, then bus lines; newest first within each.
    const rank = (impact: Impact) => (impact.target === 'bus' ? 2 : impact.target === 'line' ? 1 : 0)
    labels.sort((a, b) => rank(a.impact) - rank(b.impact) || a.age - b.age)
    for (let i = 0; i < labels.length && i < MAX_LABELS; i++) {
      const { impact, x, y, age } = labels[i]
      const tone =
        impact.target === 'line' ? pal.spark : impact.action === 'derate' ? pal.warn : pal.down
      hitLabel(x, y, impact.label, impact.detail, tone, age, pal)
    }
  }

  function ring(x: number, y: number, age: number, life: number, r0: number, r1: number, color: RGB, w: number) {
    if (!ctx || age < 0 || age > life) return
    const k = age / life
    ctx.beginPath()
    ctx.arc(x, y, r0 + (r1 - r0) * easeOut(k), 0, TAU)
    ctx.lineWidth = w * (1 - k) + 0.6
    ctx.strokeStyle = rgba(color, (1 - k) ** 1.6)
    ctx.stroke()
  }

  function burstBuilding(x: number, y: number, age: number, pal: Palette, seed: number) {
    if (!ctx) return
    if (age < 460) {
      const k = age / 460
      const r = 6 + 26 * easeOut(k)
      const fade = (1 - k) ** 1.4
      if (pal.dark) ctx.globalCompositeOperation = 'lighter'
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, `rgba(255,255,255,${fade})`)
      g.addColorStop(0.28, pal.dark ? `rgba(255,232,214,${fade * 0.8})` : rgba(pal.down, fade * 0.7))
      g.addColorStop(1, rgba(pal.down, 0))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r, 0, TAU)
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'
    }
    ring(x, y, age - 50, 1150, 7, 58, pal.down, 3.2)
    ring(x, y, age - 230, 1050, 5, 36, pal.down, 1.6)
    if (age < 760) {
      const random = rng(seed)
      const k = age / 760
      const e = easeOut(k)
      ctx.lineCap = 'round'
      ctx.lineWidth = 1.6
      for (let i = 0; i < 11; i++) {
        const angle = random() * TAU
        const speed = 0.55 + random() * 0.6
        const d0 = 5 + 34 * e * speed
        const len = (4 + random() * 5) * (1 - k)
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        ctx.strokeStyle = i % 3 === 0 ? (pal.dark ? `rgba(255,244,230,${1 - k})` : rgba(pal.down, 1 - k)) : rgba(pal.down, (1 - k) * 0.9)
        ctx.beginPath()
        ctx.moveTo(x + cos * d0, y + sin * d0)
        ctx.lineTo(x + cos * (d0 + len), y + sin * (d0 + len))
        ctx.stroke()
      }
    }
    if (age < BURST) {
      const k = age / BURST
      ctx.beginPath()
      ctx.arc(x, y, 3.2, 0, TAU)
      ctx.fillStyle = rgba(pal.down, 1 - k * k)
      ctx.fill()
    }
  }

  function burstDerate(x: number, y: number, age: number, pal: Palette) {
    ring(x, y, age, 1100, 6, 34, pal.warn, 2.4)
    ring(x, y, age - 320, 1000, 6, 26, pal.warn, 1.4)
  }

  function burstLine(x: number, y: number, age: number, pal: Palette, seed: number) {
    if (!ctx) return
    if (age < 980) {
      const k = age / 980
      const grow = easeOut(Math.min(1, age / 200))
      const fade = (1 - k) ** 1.2
      const random = rng(seed ^ Math.imul(Math.floor(age / 55) + 1, 0x9e3779b1))
      if (pal.dark) ctx.globalCompositeOperation = 'lighter'
      const glow = ctx.createRadialGradient(x, y, 0, x, y, 6 + 14 * grow)
      glow.addColorStop(0, `rgba(255,251,230,${fade})`)
      glow.addColorStop(0.4, rgba(pal.spark, fade * 0.55))
      glow.addColorStop(1, rgba(pal.spark, 0))
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(x, y, 6 + 14 * grow, 0, TAU)
      ctx.fill()
      ctx.beginPath()
      const n = 8
      for (let i = 0; i < n; i++) {
        const angle = (i / n) * TAU + random() * 0.6
        const len = (11 + random() * 17) * grow
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        tracePath(ctx, boltPoints({ x: x + cos * 3, y: y + sin * 3 }, { x: x + cos * len, y: y + sin * len }, random, 0.4, 3))
      }
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = 3.4
      ctx.strokeStyle = pal.dark ? rgba(pal.spark, 0.5 * fade) : `rgba(250,204,21,${0.7 * fade})`
      ctx.stroke()
      ctx.lineWidth = 1.2
      ctx.strokeStyle = pal.dark ? `rgba(255,251,230,${fade})` : `rgba(146,92,4,${fade})`
      ctx.stroke()
      ctx.globalCompositeOperation = 'source-over'
    }
    ring(x, y, age - 30, 900, 4, 30, pal.spark, 1.8)
  }

  function burstClose(x: number, y: number, age: number, pal: Palette) {
    if (!ctx) return
    ring(x, y, age, 1050, 9, 38, pal.down, 2.4)
    const pop = age < 340 ? easeBack(age / 340) : 1
    const out = age > BURST - 360 ? (BURST - age) / 360 : 1
    const s = Math.max(0, pop * (0.78 + 0.22 * out))
    if (s <= 0.01) return
    const r = 9.5 * s
    ctx.globalAlpha = Math.min(1, out * 1.4)
    ctx.shadowColor = pal.shadow
    ctx.shadowBlur = 8
    ctx.shadowOffsetY = 1.5
    ctx.beginPath()
    ctx.arc(x, y, r, 0, TAU)
    ctx.fillStyle = rgba(pal.down, 1)
    ctx.fill()
    ctx.shadowColor = 'transparent'
    ctx.lineWidth = 1.5
    ctx.strokeStyle = pal.dark ? 'rgba(9,11,15,0.9)' : 'rgba(255,255,255,0.95)'
    ctx.stroke()
    const d = 3.6 * s
    ctx.beginPath()
    ctx.moveTo(x - d, y - d)
    ctx.lineTo(x + d, y + d)
    ctx.moveTo(x + d, y - d)
    ctx.lineTo(x - d, y + d)
    ctx.lineCap = 'round'
    ctx.lineWidth = 2.2
    ctx.strokeStyle = '#fff'
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    g.beginPath()
    g.roundRect(x, y, w, h, r)
  }

  /** "Mary Markley Hall · direct hit", beside the hit, with a short leader. */
  function hitLabel(ax: number, ay: number, label: string, detail: string, tone: RGB | null, age: number, pal: Palette) {
    const g = lctx
    if (!g) return
    const fadeIn = clamp01(age / 180)
    const fadeOut = clamp01((LABEL - age) / 600)
    const alpha = Math.min(fadeIn, fadeOut)
    if (alpha <= 0) return
    const strong = `500 11px ${SANS}`
    const soft = `400 11px ${SANS}`
    const sep = '  ·  '
    const wl = measure(strong, label)
    const ws = measure(soft, sep)
    const wd = measure(soft, detail)
    const h = 22
    const w = 22 + wl + ws + wd + 9
    let left = ax + 18
    if (left + w > width - 8) left = ax - 18 - w
    let cy = ay - 18 + (1 - easeOut(fadeIn)) * 4
    for (let tries = 0; tries < 6; tries++) {
      const top = cy - h / 2
      const hit = placed.some((r) => left < r.x + r.w && left + w > r.x && top < r.y + r.h && top + h > r.y)
      if (!hit) break
      cy -= h + 4
    }
    placed.push({ x: left, y: cy - h / 2, w, h })

    g.save()
    g.globalAlpha = alpha
    const edgeX = left > ax ? left : left + w
    g.beginPath()
    g.moveTo(ax + Math.sign(edgeX - ax) * 6, ay - 4)
    g.lineTo(edgeX, cy)
    g.lineWidth = 1
    g.strokeStyle = pal.leader
    g.stroke()

    g.shadowColor = pal.shadow
    g.shadowBlur = 10
    g.shadowOffsetY = 2
    roundRect(g, left, cy - h / 2, w, h, 6)
    g.fillStyle = pal.pill
    g.fill()
    g.shadowColor = 'transparent'
    g.lineWidth = 1
    g.strokeStyle = pal.pillEdge
    g.stroke()

    g.beginPath()
    g.arc(left + 11, cy, 3, 0, TAU)
    g.fillStyle = tone ? rgba(tone, 1) : pal.muted
    g.fill()

    g.textBaseline = 'middle'
    g.font = strong
    g.fillStyle = pal.text
    g.fillText(label, left + 20, cy + 0.5)
    g.font = soft
    g.fillStyle = pal.muted
    g.fillText(sep, left + 20 + wl, cy + 0.5)
    g.fillText(detail, left + 20 + wl + ws, cy + 0.5)
    g.restore()
  }

  // -------------------------------------------------------------------------
  // Lasting marks: a closed bus stretch, a cut line, a closed road.
  // -------------------------------------------------------------------------

  function sprite(kind: MapMark['kind'], pal: Palette): HTMLCanvasElement {
    const key = `${kind}:${pal.dark}:${dpr}`
    const cached = sprites.get(key)
    if (cached) return cached
    const size = 26
    const pad = 5
    const s = document.createElement('canvas')
    s.width = Math.ceil(size * dpr)
    s.height = Math.ceil(size * dpr)
    const g = s.getContext('2d')
    if (g) {
      g.scale(dpr, dpr)
      g.shadowColor = pal.shadow
      g.shadowBlur = 5
      g.shadowOffsetY = 1
      g.beginPath()
      g.roundRect(pad, pad, 16, 16, 5)
      g.fillStyle = pal.dark ? '#0f1217' : '#fbfbf9'
      g.fill()
      g.shadowColor = 'transparent'
      const tone = kind === 'bus' ? pal.down : kind === 'line' ? pal.spark : null
      g.lineWidth = 1
      g.strokeStyle = tone ? rgba(tone, pal.dark ? 0.6 : 0.55) : pal.pillEdge
      g.stroke()
      g.lineCap = 'round'
      g.lineJoin = 'round'
      if (kind === 'line') {
        g.beginPath()
        g.moveTo(pad + 9.6, pad + 3.4)
        g.lineTo(pad + 5.6, pad + 8.6)
        g.lineTo(pad + 10.2, pad + 8.2)
        g.lineTo(pad + 6.4, pad + 12.8)
        g.lineWidth = 1.7
        g.strokeStyle = pal.dark ? '#facc15' : '#b07803'
        g.stroke()
      } else {
        g.beginPath()
        g.moveTo(pad + 5.2, pad + 5.2)
        g.lineTo(pad + 10.8, pad + 10.8)
        g.moveTo(pad + 10.8, pad + 5.2)
        g.lineTo(pad + 5.2, pad + 10.8)
        g.lineWidth = 1.9
        g.strokeStyle = kind === 'bus' ? rgba(pal.down, 1) : pal.dark ? '#94a3b8' : '#64748b'
        g.stroke()
      }
    }
    sprites.set(key, s)
    return s
  }

  function drawMarks(marks: readonly MapMark[], pal: Palette) {
    if (!ctx || marks.length === 0) return
    for (const mark of marks) {
      const at = project(mark.at)
      if (!near(at.x, at.y, 20)) continue
      ctx.drawImage(sprite(mark.kind, pal), Math.round(at.x) - 13, Math.round(at.y) - 13, 26, 26)
    }
  }

  // -------------------------------------------------------------------------
  // Drawing a path, and the ghost under the cursor.
  // -------------------------------------------------------------------------

  /** A cleared offscreen layer the size of the canvas, for strokes that get cut out before they land. */
  function scratch(): CanvasRenderingContext2D | null {
    if (!layer) {
      layer = document.createElement('canvas')
      layer.width = el.width
      layer.height = el.height
    }
    const g = layer.getContext('2d')
    if (!g) return null
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, layer.width, layer.height)
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (ground) g.transform(ground.a, ground.b, ground.c, ground.d, ground.e, ground.f)
    g.lineCap = 'round'
    g.lineJoin = 'round'
    return g
  }

  function blit() {
    if (!ctx || !layer) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(layer, 0, 0)
    ctx.restore()
  }

  /** Erase everything inside the swath but a hair under its edge. */
  function cutInside(g: CanvasRenderingContext2D, pts: readonly Pt[], radius: number, edge: number) {
    g.globalCompositeOperation = 'destination-out'
    g.beginPath()
    tracePath(g, pts)
    g.lineWidth = Math.max(0, radius * 2 - edge)
    g.strokeStyle = '#000'
    g.stroke()
    g.globalCompositeOperation = 'source-over'
  }

  /** A crisp outline of the swath: a fat stroke with a slightly thinner one cut out of it. */
  function swathEdge(pts: readonly Pt[], radius: number, color: string) {
    const g = scratch()
    if (!g) return
    g.beginPath()
    tracePath(g, pts)
    g.lineWidth = radius * 2 + 1.5
    g.strokeStyle = color
    g.stroke()
    cutInside(g, pts, radius, 1.5)
    blit()
  }

  /** The same outline, dashed. Traced around the swath, then the loops inside tight bends are cut away. */
  function dashedEdge(pts: readonly Pt[], radius: number, color: string, offset: number) {
    const g = scratch()
    if (!g) return
    outlinePath(g, pts, radius)
    g.setLineDash([7, 5])
    g.lineDashOffset = offset
    g.lineWidth = 1.5
    g.strokeStyle = color
    g.stroke()
    g.setLineDash([])
    cutInside(g, pts, radius, 1.5)
    blit()
  }

  /** A solid outline with a soft glow outside it, for the selected plan. */
  function glowEdge(pts: readonly Pt[], radius: number, accent: RGB) {
    const g = scratch()
    if (!g) return
    g.beginPath()
    tracePath(g, pts)
    for (const [w, a] of [
      [13, 0.06],
      [8, 0.09],
      [4.5, 0.14],
    ]) {
      g.lineWidth = radius * 2 + w
      g.strokeStyle = rgba(accent, a)
      g.stroke()
    }
    g.lineWidth = radius * 2 + 2
    g.strokeStyle = rgba(accent, 0.95)
    g.stroke()
    cutInside(g, pts, radius, 2)
    blit()
  }

  /** Chevrons along the path pointing the way it travels. A moving offset makes them drift. */
  function chevrons(pts: readonly Pt[], color: string, alpha: number, offset: number) {
    if (!ctx) return
    const spacing = 38
    const phase = ((offset % spacing) + spacing) % spacing
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = color
    let total = 0
    for (let i = 1; i < pts.length; i++) total += segLen(pts, i)
    let seg = 1
    let segStart = 0
    for (let s = phase + spacing / 2; s < total - 10; s += spacing) {
      while (seg < pts.length - 1 && segStart + segLen(pts, seg) < s) {
        segStart += segLen(pts, seg)
        seg++
      }
      const p0 = pts[seg - 1]
      const p1 = pts[seg]
      const len = segLen(pts, seg) || 1
      const k = (s - segStart) / len
      const x = p0.x + (p1.x - p0.x) * k
      const y = p0.y + (p1.y - p0.y) * k
      const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x)
      const edge = Math.min(1, s / 24, (total - s) / 24)
      ctx.globalAlpha = clamp01(edge) * alpha
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      ctx.beginPath()
      ctx.moveTo(x - cos * 4 - sin * 4.5, y - sin * 4 + cos * 4.5)
      ctx.lineTo(x + cos * 1.5, y + sin * 1.5)
      ctx.lineTo(x - cos * 4 + sin * 4.5, y - sin * 4 - cos * 4.5)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  function footprint(x: number, y: number, r: number, accent: RGB, now: number, pal: Palette, fill: number) {
    if (!ctx) return
    const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r)
    g.addColorStop(0, rgba(accent, fill * 0.4))
    g.addColorStop(1, rgba(accent, fill))
    ctx.beginPath()
    ctx.arc(x, y, r, 0, TAU)
    ctx.fillStyle = g
    ctx.fill()
    ctx.setLineDash([5, 5])
    ctx.lineDashOffset = -now / 60
    ctx.lineWidth = 1.5
    ctx.strokeStyle = rgba(accent, pal.dark ? 0.9 : 0.85)
    ctx.stroke()
    ctx.setLineDash([])
  }

  function tag(x: number, y: number, text: string, sub: string, accent: RGB, pal: Palette) {
    const g = lctx
    if (!g) return
    const strong = `500 11px ${SANS}`
    const mono = `500 11px ${MONO}`
    const wt = measure(strong, text)
    const ws = measure(mono, sub)
    const h = 22
    const w = 20 + wt + 8 + ws + 9
    let left = x - w / 2
    left = Math.max(8, Math.min(width - 8 - w, left))
    const top = Math.max(8, Math.min(height - 8 - h, y - h / 2))
    g.save()
    g.shadowColor = pal.shadow
    g.shadowBlur = 10
    g.shadowOffsetY = 2
    roundRect(g, left, top, w, h, 6)
    g.fillStyle = pal.pill
    g.fill()
    g.shadowColor = 'transparent'
    g.lineWidth = 1
    g.strokeStyle = rgba(accent, 0.55)
    g.stroke()
    g.beginPath()
    g.arc(left + 11, top + h / 2, 3, 0, TAU)
    g.fillStyle = rgba(accent, 1)
    g.fill()
    g.textBaseline = 'middle'
    g.font = strong
    g.fillStyle = pal.text
    g.fillText(text, left + 20, top + h / 2 + 0.5)
    g.font = mono
    g.fillStyle = pal.muted
    g.fillText(sub, left + 20 + wt + 8, top + h / 2 + 0.5)
    g.restore()
  }

  function drawDraft(f: Frame, d: DraftStorm, pal: Palette) {
    if (!ctx || d.path.length === 0) return
    const accent = accentOf(d.kind, pal.dark)
    const screen = projectAll(d.path)
    const label = stormLabel(d.kind, d.level)
    let reach = d.radius * f.pxPerMeter
    onGround(f, middle(d.path), (g, flat, rise) => {
      if (!ctx) return
      const pts = screen.map(flat)
      const r = d.radius * g.pxPerMeter
      const end = pts[pts.length - 1]
      reach = Math.abs(rise({ x: end.x, y: end.y - r }).y - rise(end).y)
      if (pts.length === 1) {
        footprint(end.x, end.y, r, accent, f.now, pal, 0.14)
        return
      }
      // Swath: soft fill, crisp edge.
      for (let i = 0; i < 3; i++) {
        ctx.beginPath()
        tracePath(ctx, pts)
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.lineWidth = r * 2 * (1 - i * 0.1)
        ctx.strokeStyle = rgba(accent, pal.dark ? 0.06 : 0.07)
        ctx.stroke()
      }
      swathEdge(pts, r, rgba(accent, pal.dark ? 0.55 : 0.6))

      // Centreline, marching forward.
      ctx.beginPath()
      tracePath(ctx, pts)
      ctx.setLineDash([6, 6])
      ctx.lineDashOffset = -f.now / 40
      ctx.lineWidth = 1.5
      ctx.strokeStyle = pal.centre
      ctx.stroke()
      ctx.setLineDash([])

      // Chevrons drifting along the direction of travel.
      chevrons(pts, pal.dark ? rgba(mixWhite(accent, 0.35), 1) : rgba(accent, 1), 0.95, f.now * 0.03)
      footprint(end.x, end.y, r, accent, f.now, pal, 0.1)
    })

    // Upright on screen: the start and end dots, and the tag.
    const end = screen[screen.length - 1]
    ctx.save()
    if (screen.length === 1) {
      crosshair(end.x, end.y, pal)
      tag(end.x, end.y - reach - 18, label, `${formatDistance(d.radius * 2)} across`, accent, pal)
      ctx.restore()
      return
    }
    const start = screen[0]
    ctx.beginPath()
    ctx.arc(start.x, start.y, 4.5, 0, TAU)
    ctx.fillStyle = pal.pill
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = rgba(accent, 1)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(end.x, end.y, 3.5, 0, TAU)
    ctx.fillStyle = rgba(accent, 1)
    ctx.fill()
    const above = end.y - reach - 18
    tag(end.x, above < 16 ? end.y + reach + 18 : above, label, formatDistance(pathLength(d.path)), accent, pal)
    ctx.restore()
  }

  function crosshair(x: number, y: number, pal: Palette) {
    if (!ctx) return
    ctx.beginPath()
    for (let i = 0; i < 4; i++) {
      const cos = Math.round(Math.cos((i * Math.PI) / 2))
      const sin = Math.round(Math.sin((i * Math.PI) / 2))
      ctx.moveTo(x + cos * 4, y + sin * 4)
      ctx.lineTo(x + cos * 10, y + sin * 10)
    }
    ctx.lineCap = 'round'
    ctx.lineWidth = 1.5
    ctx.strokeStyle = pal.centre
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, 1.6, 0, TAU)
    ctx.fillStyle = pal.centre
    ctx.fill()
  }

  function drawHover(f: Frame, h: HoverStorm, pal: Palette) {
    if (!ctx) return
    const accent = accentOf(h.kind, pal.dark)
    const breathe = Math.sin(f.now / 520)
    onGround(f, h.at, (g, flat) => {
      if (!ctx) return
      const at = flat(project(h.at))
      ctx.globalAlpha = 0.82 + 0.18 * breathe
      footprint(at.x, at.y, Math.max(6, h.radius * g.pxPerMeter * (1 + 0.025 * breathe)), accent, f.now, pal, 0.1)
    })
    const at = project(h.at)
    crosshair(at.x, at.y, pal)
  }

  // -------------------------------------------------------------------------
  // Planned storms: the footprint each will sweep when the scenario runs.
  // -------------------------------------------------------------------------

  function drawGhosts(f: Frame, staged: readonly StagedStorm[], selectedId: string | null, pal: Palette, startsAt: string) {
    if (staged.length === 0) return
    let chosen: StagedStorm | null = null
    for (const g of staged) {
      if (g.id === selectedId) chosen = g
      else drawGhost(f, g, false, pal, startsAt)
    }
    // The selected one lands on top of any it overlaps.
    if (chosen) drawGhost(f, chosen, true, pal, startsAt)
  }

  function drawGhost(f: Frame, g: StagedStorm, selected: boolean, pal: Palette, startsAt: string) {
    if (!ctx || g.path.length === 0) return
    const accent = accentOf(g.kind, pal.dark)
    const screen = dedupe(projectAll(g.path))
    if (!boundsNear(screen, Math.max(5, g.radius * f.pxPerMeter) + 40)) return
    const march = selected ? -f.now / 55 : 0
    // Where the badge and tag go, worked out on the ground and brought back to the screen.
    let rim: Pt = screen[0]
    let reach = g.radius * f.pxPerMeter
    onGround(f, middle(g.path), (frame, flat, rise) => {
      if (!ctx) return
      const pts = screen.map(flat)
      const r = Math.max(5, g.radius * frame.pxPerMeter)
      const end = pts[pts.length - 1]
      reach = Math.abs(rise({ x: end.x, y: end.y - r }).y - rise(end).y)
      if (pts.length === 1) {
        ghostDisc(end.x, end.y, r, accent, selected, march, pal)
        // On the rim, so the badge never hides what sits at the centre.
        rim = rise({ x: end.x - r * 0.707, y: end.y - r * 0.707 })
        return
      }

      // Swath: one even wash.
      ctx.beginPath()
      tracePath(ctx, pts)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = r * 2
      ctx.strokeStyle = rgba(accent, selected ? (pal.dark ? 0.15 : 0.16) : pal.dark ? 0.075 : 0.085)
      ctx.stroke()

      // Edge: dashed while it waits, solid with a glow when selected.
      if (selected) glowEdge(pts, r, accent)
      else dashedEdge(pts, r, rgba(accent, pal.dark ? 0.72 : 0.75), 0)

      // Where it ends up: the footprint, a touch stronger toward its rim.
      const disc = ctx.createRadialGradient(end.x, end.y, r * 0.15, end.x, end.y, r)
      disc.addColorStop(0, rgba(accent, 0))
      disc.addColorStop(1, rgba(accent, selected ? 0.16 : 0.1))
      ctx.beginPath()
      ctx.arc(end.x, end.y, r, 0, TAU)
      ctx.fillStyle = disc
      ctx.fill()

      // Centreline and direction.
      ctx.beginPath()
      tracePath(ctx, pts)
      ctx.setLineDash(selected ? [6, 6] : [3, 6])
      ctx.lineDashOffset = selected ? -f.now / 40 : 0
      ctx.lineWidth = selected ? 1.5 : 1.25
      ctx.strokeStyle = selected ? pal.centre : rgba(pal.dark ? mixWhite(accent, 0.4) : accent, 0.55)
      ctx.stroke()
      ctx.setLineDash([])
      chevrons(pts, pal.dark ? rgba(mixWhite(accent, 0.35), 1) : rgba(accent, 1), selected ? 0.95 : 0.5, selected ? f.now * 0.02 : 0)
    })

    // Upright on screen: the end dot, the grab handle, the plan number and the tag.
    const end = screen[screen.length - 1]
    ctx.save()
    if (screen.length === 1) {
      if (selected) handle(end.x, end.y, accent, pal)
      badge(rim.x, rim.y, g.index, accent, selected, pal)
    } else {
      ctx.beginPath()
      ctx.arc(end.x, end.y, selected ? 3.5 : 3, 0, TAU)
      ctx.fillStyle = rgba(accent, selected ? 1 : 0.8)
      ctx.fill()
      if (selected) {
        const mid = alongScreen(screen, 0.5)
        handle(mid.x, mid.y, accent, pal)
      }
      badge(screen[0].x, screen[0].y, g.index, accent, selected, pal)
    }
    if (selected) ghostTag(end.x, end.y, reach, g, accent, pal, startsAt)
    ctx.restore()
  }

  /** A storm planned in place: its footprint, edged like a swath. */
  function ghostDisc(x: number, y: number, r: number, accent: RGB, selected: boolean, march: number, pal: Palette) {
    if (!ctx) return
    const fill = ctx.createRadialGradient(x, y, r * 0.15, x, y, r)
    fill.addColorStop(0, rgba(accent, selected ? 0.08 : 0.04))
    fill.addColorStop(1, rgba(accent, selected ? 0.2 : 0.11))
    ctx.beginPath()
    ctx.arc(x, y, r, 0, TAU)
    ctx.fillStyle = fill
    ctx.fill()
    if (selected) {
      for (const [w, a] of [
        [9, 0.07],
        [5, 0.12],
      ]) {
        ctx.beginPath()
        ctx.arc(x, y, r + w / 2, 0, TAU)
        ctx.lineWidth = w
        ctx.strokeStyle = rgba(accent, a)
        ctx.stroke()
      }
      ctx.beginPath()
      ctx.arc(x, y, r, 0, TAU)
      ctx.lineWidth = 2
      ctx.strokeStyle = rgba(accent, 0.95)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(x, y, Math.max(2, r - 6), 0, TAU)
      ctx.setLineDash([4, 6])
      ctx.lineDashOffset = march
      ctx.lineWidth = 1.25
      ctx.strokeStyle = rgba(accent, 0.6)
      ctx.stroke()
      ctx.setLineDash([])
      return
    }
    ctx.beginPath()
    ctx.arc(x, y, r, 0, TAU)
    ctx.setLineDash([7, 5])
    ctx.lineWidth = 1.5
    ctx.strokeStyle = rgba(accent, pal.dark ? 0.72 : 0.75)
    ctx.stroke()
    ctx.setLineDash([])
  }

  /** The plan's number, matching the row in the dock. */
  function badge(x: number, y: number, n: number, accent: RGB, selected: boolean, pal: Palette) {
    if (!ctx) return
    const r = selected ? 10 : 8.5
    ctx.save()
    if (selected) {
      ctx.beginPath()
      ctx.arc(x, y, r + 4.5, 0, TAU)
      ctx.fillStyle = rgba(accent, 0.22)
      ctx.fill()
    }
    ctx.shadowColor = pal.shadow
    ctx.shadowBlur = 6
    ctx.shadowOffsetY = 1
    ctx.beginPath()
    ctx.arc(x, y, r, 0, TAU)
    ctx.fillStyle = selected ? rgba(accent, 1) : pal.pill
    ctx.fill()
    ctx.shadowColor = 'transparent'
    ctx.lineWidth = selected ? 2 : 1.5
    ctx.strokeStyle = selected ? pal.pill : rgba(accent, 0.95)
    ctx.stroke()
    ctx.font = `600 ${selected ? 11 : 10}px ${MONO}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = selected ? (pal.dark ? '#0b0d11' : '#ffffff') : pal.dark ? rgba(mixWhite(accent, 0.25), 1) : rgba(accent, 1)
    ctx.fillText(String(n), x, y + 0.5)
    ctx.restore()
  }

  /** A small grab dot at the middle of the selected plan. */
  function handle(x: number, y: number, accent: RGB, pal: Palette) {
    if (!ctx) return
    ctx.save()
    ctx.shadowColor = pal.shadow
    ctx.shadowBlur = 8
    ctx.shadowOffsetY = 1.5
    ctx.beginPath()
    ctx.arc(x, y, 6, 0, TAU)
    ctx.fillStyle = pal.pill
    ctx.fill()
    ctx.shadowColor = 'transparent'
    ctx.lineWidth = 2
    ctx.strokeStyle = rgba(accent, 1)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, 2.2, 0, TAU)
    ctx.fillStyle = rgba(accent, 1)
    ctx.fill()
    ctx.restore()
  }

  /** The selected plan's name and when it starts, on the same clock as its chip in the dock. */
  function ghostTag(x: number, y: number, r: number, g: StagedStorm, accent: RGB, pal: Palette, startsAt: string) {
    const above = y - r - 20
    tag(x, above < 16 ? y + r + 20 : above, stormLabel(g.kind, g.level), simClock(startsAt, g.start), accent, pal)
  }

  /** The point a fraction of the way along a projected path. */
  function alongScreen(pts: readonly Pt[], k: number): Pt {
    let total = 0
    for (let i = 1; i < pts.length; i++) total += segLen(pts, i)
    let left = total * k
    for (let i = 1; i < pts.length; i++) {
      const len = segLen(pts, i)
      if (left <= len && len > 0) {
        const t = left / len
        return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }
      }
      left -= len
    }
    return pts[pts.length - 1]
  }

  const onMove = () => wake()
  // Labels measured before IBM Plex arrived would keep the fallback font's widths.
  const onFonts = () => {
    widths.clear()
    wake()
  }
  document.fonts?.addEventListener('loadingdone', onFonts)
  const ro = new ResizeObserver(resize)
  ro.observe(host)
  const themes = new MutationObserver(onMove)
  themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  media.addEventListener('change', onMove)
  map.on('move', onMove)
  map.on('resize', resize)
  resize()

  return {
    wake,
    destroy() {
      alive = false
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      ro.disconnect()
      themes.disconnect()
      media.removeEventListener('change', onMove)
      document.fonts?.removeEventListener('loadingdone', onFonts)
      map.off('move', onMove)
      map.off('resize', resize)
      el.remove()
      over.remove()
    },
  }
}

function segLen(pts: readonly Pt[], i: number): number {
  return Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
}

/** Drop points that land on top of the one before, so every segment has a direction. */
function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const q = out[out.length - 1]
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 0.75) out.push(p)
  }
  return out
}

/**
 * Trace the outline of a round-capped swath of half-width r around a polyline:
 * down one side, around the far end, back up the other side, around the start.
 * Outer bends get an arc; inner bends cross over themselves, inside the swath.
 */
function outlinePath(g: CanvasRenderingContext2D, pts: readonly Pt[], r: number) {
  const seq = [...pts, ...pts.slice(0, -1).reverse()]
  const n = seq.length
  g.beginPath()
  for (let i = 0; i < n - 1; i++) {
    const a = seq[i]
    const b = seq[i + 1]
    const c = i + 2 < n ? seq[i + 2] : seq[1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const nx = (-dy / len) * r
    const ny = (dx / len) * r
    if (i === 0) g.moveTo(a.x + nx, a.y + ny)
    g.lineTo(b.x + nx, b.y + ny)
    const ex = c.x - b.x
    const ey = c.y - b.y
    const elen = Math.hypot(ex, ey) || 1
    const mx = (-ey / elen) * r
    const my = (ex / elen) * r
    const cross = dx * ey - dy * ex
    const dot = dx * ex + dy * ey
    if (cross < 0 || (cross === 0 && dot < 0)) g.arc(b.x, b.y, r, Math.atan2(ny, nx), Math.atan2(my, mx), true)
    else g.lineTo(b.x + mx, b.y + my)
  }
  g.closePath()
}

function mixWhite(c: RGB, k: number): RGB {
  return [c[0] + (255 - c[0]) * k, c[1] + (255 - c[1]) * k, c[2] + (255 - c[2]) * k].map(Math.round) as RGB
}
