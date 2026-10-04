/**
 * What a drawn storm does to the campus, and when in its run each hit lands.
 * Pure: the same storm over the same campus always gives the same list.
 */
import type { ProposalPin } from '../api'
import { PLACES } from '../places'
import type { SimEdge, SimNode } from '../sim'
import { distPointPath, distSegSeg, firstContact, STRIKE } from './geo'
import { STORM_SPECS, type BusLine, type Impact, type ImpactCounts, type LngLat, type Storm } from './types'

/** City buildings are off the map, and on the city grid. Weather drawn here leaves them alone. */
const CITY = new Set(['city_hall', 'blake', 'fire_1'])

/** The power plant's emergency tie into the hospital. Cutting it fails no building. */
const TIE = 'power:cpp->uh'

export interface WorldNode {
  id: string
  name: string
  /** A feed: a substation, or the hospital's own utility intake. */
  feed: boolean
  failed: boolean
  at: LngLat
}

export interface WorldLine {
  id: string
  label: string
  a: LngLat
  b: LngLat
  /** Node that goes dark when this line is cut. Null for the tie. */
  target: string | null
  /** DTE's overhead feed into North Campus. Central Campus is underground. */
  overhead: boolean
}

export interface WorldRoad {
  id: string
  label: string
  a: LngLat
  b: LngLat
}

export interface World {
  nodes: WorldNode[]
  lines: WorldLine[]
  roads: WorldRoad[]
  buses: BusLine[]
}

export function buildWorld(
  nodes: readonly SimNode[],
  edges: readonly SimEdge[],
  proposals: readonly ProposalPin[],
  buses: readonly BusLine[],
): World {
  const where = new Map<string, LngLat>()
  for (const node of nodes) {
    const place = PLACES[node.id]
    if (place && !CITY.has(node.id)) where.set(node.id, [place.lng, place.lat])
  }
  for (const pin of proposals) where.set(pin.id, [pin.lng, pin.lat])
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const name = (id: string) => byId.get(id)?.name ?? id

  const world: World = { nodes: [], lines: [], roads: [], buses: [...buses] }
  for (const node of nodes) {
    const at = where.get(node.id)
    if (!at) continue
    world.nodes.push({ id: node.id, name: node.name, feed: node.type === 'substation' || node.id === 'uh', failed: node.failed, at })
  }
  for (const edge of edges) {
    const a = where.get(edge.source)
    const b = where.get(edge.target)
    if (!a || !b) continue
    const label = `${PLACES[edge.source]?.short ?? name(edge.source)} → ${PLACES[edge.target]?.short ?? name(edge.target)}`
    if (edge.type === 'power') {
      world.lines.push({ id: edge.id, label, a, b, target: edge.id === TIE ? null : edge.target, overhead: edge.source === 'north_switch' })
    } else if (edge.type === 'road') {
      world.roads.push({ id: edge.id, label, a, b })
    }
  }
  return world
}

/** Rules for one kind of storm at one level. Distances are fractions of the footprint radius. */
interface Rules {
  /** Buildings and feeds inside this reach fail. */
  fail?: number
  failDetail?: string
  /** Feeds inside the footprint run at this fraction. */
  derate?: number
  /** Lines crossing within this reach are cut. */
  cut?: number
  overheadOnly?: boolean
  cutDetail?: string
  /** Bus lines and roads within this reach close. */
  close?: number
  closeDetail?: string
  /** Lightning: only the single nearest thing is hit. */
  nearestOnly?: boolean
}

function rules(kind: Storm['kind'], level: number): Rules {
  switch (kind) {
    case 'tornado':
      return { fail: 1, failDetail: 'direct hit', cut: 1, cutDetail: 'switchgear destroyed', close: 1, closeDetail: 'debris across the road' }
    case 'thunderstorm':
      return {
        derate: [0.75, 0.6, 0.45][level],
        cut: level >= 1 ? 0.8 : undefined,
        overheadOnly: true,
        cutDetail: 'tree on the overhead line',
        fail: level >= 2 ? 0.2 : undefined,
        failDetail: 'lightning strike',
        close: [0.5, 0.8, 0.9][level],
        closeDetail: 'trees down',
      }
    case 'ice':
      return {
        derate: [0.8, 0.6, 0.45][level],
        cut: level >= 1 ? 1 : undefined,
        overheadOnly: true,
        cutDetail: 'iced line snapped',
        close: level >= 1 ? 1 : undefined,
        closeDetail: 'glazed roads',
      }
    case 'flood':
      return { fail: 1, failDetail: 'switchgear under water', close: 1, closeDetail: 'road under water' }
    case 'blizzard':
      return { derate: [0.9, 0.75, 0.6][level], close: 1, closeDetail: 'snowed in' }
    case 'lightning':
      return { fail: 1, failDetail: 'lightning strike', cut: 1, cutDetail: 'lightning on the line', nearestOnly: true }
    case 'blackout':
      return { fail: 1, failDetail: 'power cut', cut: 1, cutDetail: 'line cut' }
    case 'closure':
      return { close: 1, closeDetail: 'closed by order' }
  }
}

/** Every hit this storm makes, earliest first. */
export function computeImpacts(storm: Storm, world: World): Impact[] {
  const r = storm.radius
  const rule = rules(storm.kind, storm.level)
  const path = storm.path
  const out: Impact[] = []
  const down = new Set(world.nodes.filter((node) => node.failed).map((node) => node.id))

  if (rule.nearestOnly) return lightning(storm, world, rule, down)

  for (const node of world.nodes) {
    const gap = (center: LngLat) => distPointPath(node.at, [center])
    if (rule.fail !== undefined) {
      const t = firstContact(path, r * rule.fail, gap)
      if (t !== null) {
        out.push({
          key: `${node.feed ? 'feed' : 'building'}:${node.id}`,
          t,
          target: node.feed ? 'feed' : 'building',
          action: 'fail',
          at: node.at,
          label: node.name,
          detail: rule.failDetail ?? 'offline',
          nodeIds: down.has(node.id) ? [] : [node.id],
        })
        continue
      }
    }
    if (rule.derate !== undefined && node.feed && !down.has(node.id)) {
      const t = firstContact(path, r, gap)
      if (t !== null) {
        out.push({
          key: `feed:${node.id}`,
          t,
          target: 'feed',
          action: 'derate',
          at: node.at,
          label: node.name,
          detail: `output cut to ${Math.round(rule.derate * 100)}%`,
          nodeIds: [node.id],
          factor: rule.derate,
        })
      }
    }
  }

  if (rule.cut !== undefined) {
    for (const line of world.lines) {
      if (rule.overheadOnly && !line.overhead) continue
      const t = firstContact(path, r * rule.cut, (center) => distSegSeg(center, center, line.a, line.b))
      if (t === null) continue
      // When this storm takes out the building or feed at either end, that is the hit, not a cut along the line.
      const at = crossing(path, line.a, line.b)
      const failReach = rule.fail === undefined ? -1 : r * rule.fail
      if (distPointPath(line.a, path) <= failReach || distPointPath(line.b, path) <= failReach) continue
      out.push({
        key: `line:${line.id}`,
        t,
        target: 'line',
        action: 'cut',
        at,
        label: line.label,
        detail: rule.cutDetail ?? 'line down',
        nodeIds: [],
        edgeId: line.id,
      })
    }
  }

  if (rule.close !== undefined) {
    const reach = r * rule.close
    const routes = new Map<string, { name: string; t: number; segments: LngLat[][]; at: LngLat }>()
    for (const bus of world.buses) {
      const runs = closedRuns(bus.coords, path, reach)
      if (runs.length === 0) continue
      let t = Infinity
      let at = runs[0][0]
      for (const run of runs) {
        for (const p of run) {
          const hit = firstContact(path, reach, (center) => distPointPath(p, [center]))
          if (hit !== null && hit < t) {
            t = hit
            at = p
          }
        }
      }
      const entry = routes.get(bus.id) ?? { name: bus.name, t, segments: [], at }
      entry.segments.push(...runs)
      if (t < entry.t) {
        entry.t = t
        entry.at = at
      }
      routes.set(bus.id, entry)
    }
    for (const [id, entry] of routes) {
      out.push({
        key: `bus:${id}`,
        t: Number.isFinite(entry.t) ? entry.t : 0.5,
        target: 'bus',
        action: 'close',
        at: entry.at,
        label: entry.name,
        detail: rule.closeDetail ?? 'closed',
        nodeIds: [],
        route: { id, name: entry.name, segments: entry.segments },
      })
    }
    for (const road of world.roads) {
      const t = firstContact(path, reach, (center) => distSegSeg(center, center, road.a, road.b))
      if (t === null) continue
      out.push({
        key: `road:${road.id}`,
        t,
        target: 'road',
        action: 'close',
        at: crossing(path, road.a, road.b),
        label: road.label,
        detail: rule.closeDetail ?? 'closed',
        nodeIds: [],
        edgeId: road.id,
      })
    }
  }

  out.sort((a, b) => a.t - b.t || a.key.localeCompare(b.key))
  return assignLineFailures(out, world, down)
}

/** A cut line darkens the building it feeds, unless something earlier already took that building down. */
function assignLineFailures(impacts: Impact[], world: World, down: Set<string>): Impact[] {
  const gone = new Set(down)
  const target = new Map(world.lines.map((line) => [line.id, line.target]))
  return impacts.map((impact) => {
    if (impact.action === 'fail') {
      impact.nodeIds.forEach((id) => gone.add(id))
      return impact
    }
    if (impact.action !== 'cut' || !impact.edgeId) return impact
    const node = target.get(impact.edgeId)
    if (!node || gone.has(node)) return impact
    gone.add(node)
    return { ...impact, nodeIds: [node] }
  })
}

function lightning(storm: Storm, world: World, rule: Rules, down: Set<string>): Impact[] {
  const at = storm.path[0]
  const r = storm.radius
  let best: { node: WorldNode; d: number } | null = null
  for (const node of world.nodes) {
    const d = distPointPath(node.at, [at])
    if (d <= r && (!best || d < best.d)) best = { node, d }
  }
  if (best) {
    return [{
      key: `${best.node.feed ? 'feed' : 'building'}:${best.node.id}`,
      t: STRIKE,
      target: best.node.feed ? 'feed' : 'building',
      action: 'fail',
      at: best.node.at,
      label: best.node.name,
      detail: rule.failDetail ?? 'lightning strike',
      nodeIds: down.has(best.node.id) ? [] : [best.node.id],
    }]
  }
  let line: { line: WorldLine; d: number } | null = null
  for (const candidate of world.lines) {
    const d = distSegSeg(at, at, candidate.a, candidate.b)
    if (d <= r && (!line || d < line.d)) line = { line: candidate, d }
  }
  if (!line) return []
  return assignLineFailures([{
    key: `line:${line.line.id}`,
    t: STRIKE,
    target: 'line',
    action: 'cut',
    at: crossing([at], line.line.a, line.line.b),
    label: line.line.label,
    detail: rule.cutDetail ?? 'line down',
    nodeIds: [],
    edgeId: line.line.id,
  }], world, down)
}

/** Stretches of a bus line inside the storm's reach. */
function closedRuns(coords: readonly LngLat[], path: readonly LngLat[], reach: number): LngLat[][] {
  const inside = coords.map((p) => distPointPath(p, path) <= reach)
  const runs: LngLat[][] = []
  let i = 0
  while (i < coords.length) {
    if (!inside[i]) {
      i++
      continue
    }
    let j = i
    while (j + 1 < coords.length && inside[j + 1]) j++
    const run = coords.slice(Math.max(0, i - 1), Math.min(coords.length, j + 2))
    if (run.length >= 2) runs.push(run)
    i = j + 1
  }
  return runs
}

/** Where on segment a-b the storm passes closest. Drawn as the cut. */
function crossing(path: readonly LngLat[], a: LngLat, b: LngLat): LngLat {
  let best: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  let bestD = Infinity
  for (let i = 0; i <= 40; i++) {
    const f = i / 40
    const p: LngLat = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
    const d = distPointPath(p, path)
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

export function countImpacts(impacts: readonly Impact[]): ImpactCounts {
  const counts: ImpactCounts = { buildings: 0, feeds: 0, lines: 0, buses: 0, roads: 0 }
  for (const impact of impacts) {
    if (impact.target === 'building') counts.buildings++
    else if (impact.target === 'feed') counts.feeds++
    else if (impact.target === 'line') counts.lines++
    else if (impact.target === 'bus') counts.buses++
    else counts.roads++
  }
  return counts
}

const LABELS: Record<Storm['kind'], string[]> = {
  tornado: ['EF1 tornado', 'EF2 tornado', 'EF3 tornado', 'EF4 tornado'],
  thunderstorm: ['Strong thunderstorm', 'Severe thunderstorm', 'Derecho'],
  ice: ['Light glaze', 'Ice storm', 'Crippling ice storm'],
  flood: ['Minor flash flood', 'Flash flood', 'Major flash flood'],
  blizzard: ['Heavy snow', 'Blizzard', 'Whiteout blizzard'],
  lightning: ['Lightning strike', 'Strong lightning strike', 'Superbolt'],
  blackout: ['Power cut', 'District power cut', 'Wide power cut'],
  closure: ['Lane closure', 'Street closure', 'Corridor closure'],
}

export function stormLabel(kind: Storm['kind'], level: number): string {
  const names = LABELS[kind]
  return names[Math.max(0, Math.min(names.length - 1, level))] ?? STORM_SPECS[kind].label
}
