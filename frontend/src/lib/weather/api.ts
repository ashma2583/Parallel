/**
 * Client for the engine's weather routes. An engine that predates them answers
 * 404 or 405, which comes back as NoStormRoutes so the caller can fall back to
 * /disrupt and keep the weather in the browser. A hit or end for a storm from
 * before the last scenario run answers 409; that is expected and comes back as null.
 * A hit for a storm the engine has no record of means it was reset: StormGone.
 */
import { BACKEND_URL } from '../../config'
import { EMPTY_WEATHER, type ClosedRoute, type EdgeMark, type LngLat, type StormKind, type WeatherState } from './types'

export class NoStormRoutes extends Error {
  constructor() {
    super('The engine has no weather routes yet. Restart it to keep storms on record.')
    this.name = 'NoStormRoutes'
  }
}

/** The engine has no record of this storm, so it was reset after the storm started. */
export class StormGone extends Error {
  constructor() {
    super('The engine no longer has this storm on record.')
    this.name = 'StormGone'
  }
}

/** The engine takes at most this many feed lines per hit. */
export const MAX_HIT_LINES = 24

/** The engine keeps this many storms on record and forgets the oldest past it. What they did stays applied. */
export const MAX_STORMS = 40

export interface StormStart {
  id: string
  kind: StormKind
  level: number
  label: string
  path: LngLat[]
  radius: number
  /** "EF3 tornado touched down near Markley Hall, heading north-east for 2.1 km" */
  headline: string
}

export interface StormHit {
  storm_id: string
  fail: string[]
  derate: { node_id: string; factor: number }[]
  cut_edges: EdgeMark[]
  close_roads: EdgeMark[]
  close_routes: ClosedRoute[]
  /** One line per hit, for the agent feed. */
  lines: string[]
}

/** Fill in whatever a partial or missing payload left out. */
export function asWeather(raw: unknown): WeatherState {
  if (!raw || typeof raw !== 'object') return EMPTY_WEATHER
  const w = raw as Partial<WeatherState>
  return {
    storms: Array.isArray(w.storms) ? w.storms : [],
    closed_routes: Array.isArray(w.closed_routes) ? w.closed_routes : [],
    cut_edges: Array.isArray(w.cut_edges) ? w.cut_edges : [],
    closed_roads: Array.isArray(w.closed_roads) ? w.closed_roads : [],
  }
}

/** The engine dropped this storm when a scenario run put the campus back. */
class StaleStorm extends Error {
  constructor() {
    super('stale storm')
    this.name = 'StaleStorm'
  }
}

async function request(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(
    `${BACKEND_URL}${path}`,
    body === undefined
      ? undefined
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    // FastAPI answers an unknown route with exactly "Not Found". A 404 the
    // weather routes raise themselves (an unknown storm id) carries its own detail.
    const detail = data && typeof data.detail === 'string' ? data.detail : res.statusText
    if (res.status === 405 || (res.status === 404 && (detail === 'Not Found' || !detail))) throw new NoStormRoutes()
    if (res.status === 409) throw new StaleStorm()
    if (res.status === 404) throw new StormGone()
    throw new Error(`${path} -> ${res.status} ${detail}`)
  }
  return data
}

async function call(path: string, body?: unknown): Promise<WeatherState> {
  const data = await request(path, body)
  return asWeather(data && typeof data === 'object' && 'weather' in data ? data.weather : data)
}

/** Null when the engine no longer runs this storm. */
async function callLive(path: string, body: unknown): Promise<WeatherState | null> {
  try {
    return await call(path, body)
  } catch (err) {
    if (err instanceof StaleStorm) return null
    throw err
  }
}

export function fetchStorms(): Promise<WeatherState> {
  return call('/storms')
}

export function startStorm(storm: StormStart): Promise<WeatherState> {
  return call('/storms/start', storm)
}

/**
 * Null when the storm is from before the last scenario run; the hit is dropped.
 * Throws StormGone when the engine was reset since the storm started.
 */
export async function hitStorm(hit: StormHit): Promise<WeatherState | null> {
  let reply: WeatherState | null = null
  for (const part of splitHit(hit)) {
    reply = await callLive('/storms/hit', part)
    if (!reply) return null
  }
  return reply
}

/** A hit with more feed lines than the engine takes, as several. The first one carries the damage. */
export function splitHit(hit: StormHit): StormHit[] {
  if (hit.lines.length <= MAX_HIT_LINES) return [hit]
  const out: StormHit[] = []
  for (let i = 0; i < hit.lines.length; i += MAX_HIT_LINES) {
    const lines = hit.lines.slice(i, i + MAX_HIT_LINES)
    out.push(i === 0 ? { ...hit, lines } : { storm_id: hit.storm_id, fail: [], derate: [], cut_edges: [], close_roads: [], close_routes: [], lines })
  }
  return out
}

/**
 * Null when the engine no longer has the storm, e.g. after a reset. `path` is how far
 * a storm stopped part way got; an engine that does not keep it keeps the drawn one.
 */
export async function endStorm(stormId: string, summary: string, path?: readonly LngLat[]): Promise<WeatherState | null> {
  try {
    return await callLive('/storms/end', { storm_id: stormId, summary, ...(path && path.length > 0 ? { path } : {}) })
  } catch (err) {
    if (err instanceof StormGone) return null
    throw err
  }
}

/** Storms this tab started on the engine and has not ended. Per tab, so a reload finds its own. */
const LIVE_KEY = 'parallel-live-storms'

type LiveRecord = { id: string; label: string }

function readLive(): LiveRecord[] {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(LIVE_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((s): s is LiveRecord => Boolean(s) && typeof s.id === 'string' && typeof s.label === 'string') : []
  } catch {
    return []
  }
}

function writeLive(list: LiveRecord[]) {
  try {
    if (list.length > 0) sessionStorage.setItem(LIVE_KEY, JSON.stringify(list))
    else sessionStorage.removeItem(LIVE_KEY)
  } catch {
    // Storage blocked: a reload part way just leaves the storm active, as before.
  }
}

export function markLive(storm: { id: string; label: string }) {
  writeLive([...readLive().filter((s) => s.id !== storm.id), { id: storm.id, label: storm.label }])
}

/** Null forgets them all, e.g. when a new run clears the engine's storms anyway. */
export function unmarkLive(stormId: string | null) {
  writeLive(stormId === null ? [] : readLive().filter((s) => s.id !== stormId))
}

/** How far a storm stopped part way got: its path up to there, and its size then. An empty path means it never got going. */
export interface StormCut {
  path: LngLat[]
  radius: number
}

/** Cuts for storms this tab stopped, so the map draws only the ground they crossed. Per tab, so a reload keeps them. */
const CUT_KEY = 'parallel-storm-cuts'
const MAX_CUTS = 60

export function readCuts(): Record<string, StormCut> {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(CUT_KEY) ?? '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, StormCut>) : {}
  } catch {
    return {}
  }
}

/** Keep these cuts. Null forgets them all, e.g. after a campus reset. */
export function saveCuts(cuts: Record<string, StormCut> | null): Record<string, StormCut> {
  const kept = cuts ? Object.fromEntries(Object.entries(cuts).slice(-MAX_CUTS)) : {}
  try {
    if (Object.keys(kept).length > 0) sessionStorage.setItem(CUT_KEY, JSON.stringify(kept))
    else sessionStorage.removeItem(CUT_KEY)
  } catch {
    // Storage blocked: the cut lasts until the page reloads.
  }
  return kept
}

/**
 * End storms this tab left running on the engine, e.g. by reloading part way through a run. True when one was ended.
 * Each one stays on the list until the engine has ended it or said it is gone, so a second quick reload still finds it.
 */
export async function endAbandoned(): Promise<boolean> {
  const left = readLive()
  if (left.length === 0) return false
  let now: WeatherState
  try {
    now = await fetchStorms()
  } catch (err) {
    // No weather routes: nothing on the engine to end. Unreachable: try again on the next load.
    if (err instanceof NoStormRoutes) writeLive([])
    return false
  }
  let ended = false
  const cuts = readCuts()
  for (const s of left) {
    if (now.storms.some((r) => r.id === s.id && r.status === 'active')) {
      try {
        await endStorm(s.id, `${s.label} stopped part way: the page was reloaded`, cuts[s.id]?.path)
        ended = true
      } catch {
        continue
      }
    }
    unmarkLive(s.id)
  }
  return ended
}

/**
 * Start a run of the scenario plan. The first run saves the campus as it
 * stands; each later run puts it back that way. Weather on record is cleared.
 */
export async function runScenario(): Promise<{ restored: boolean; weather: WeatherState }> {
  const data = await request('/storms/scenario/run', {})
  const body = data && typeof data === 'object' ? (data as { restored?: unknown; weather?: unknown }) : {}
  return { restored: body.restored === true, weather: asWeather(body.weather) }
}

/** Forget the saved starting state. The next run saves the campus as it is then. */
export async function clearScenario(): Promise<void> {
  await request('/storms/scenario/clear', {})
}

/** The campus as the engine has it: nodes failed, buildings dark (failed or out of power, as the zone bars count them), feeds cut back. */
export interface CampusMark {
  down: Set<string>
  dark: Set<string>
  derated: Set<string>
}

/** The campus right now, or null when it cannot be read. */
export async function fetchCampus(): Promise<CampusMark | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/state`)
    if (!res.ok) return null
    return campusIn(await res.json())
  } catch {
    return null
  }
}

/** The campus in a reply that carries its state, or null when it has none. */
export function campusIn(data: unknown): CampusMark | null {
  const nodes = data && typeof data === 'object' ? (data as { nodes?: unknown }).nodes : null
  if (!Array.isArray(nodes)) return null
  const mark: CampusMark = { down: new Set(), dark: new Set(), derated: new Set() }
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue
    const node = raw as { id?: unknown; failed?: unknown; status?: unknown; type?: unknown; derate?: unknown }
    if (typeof node.id !== 'string') continue
    const feed = node.type === 'substation'
    if (node.failed === true) mark.down.add(node.id)
    if (!feed && (node.failed === true || node.status === 'Red')) mark.dark.add(node.id)
    else if (node.failed !== true && typeof node.derate === 'number' && node.derate < 0.999) mark.derated.add(node.id)
  }
  return mark
}

/** Ids of nodes the engine has failed right now, or null when it cannot be read. */
export async function fetchDown(): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/state`)
    if (!res.ok) return null
    return downIn(await res.json())
  } catch {
    return null
  }
}

/**
 * Where the engine's clock and agent feed stand. A reset puts the tick back near
 * zero, empties the feed and logs "campus reset", so comparing two marks shows one.
 */
export interface EngineMark {
  tick: number
  /** Lines in the feed. It only ever grows, up to its cap, until a reset empties it. */
  lines: number
  /** Tick of the newest "campus reset" line, or null when the feed has none. */
  reset: number | null
}

/** The engine's mark right now, or null when it cannot be read. */
export async function fetchMark(): Promise<EngineMark | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/state`)
    if (!res.ok) return null
    const data = (await res.json()) as { tick?: unknown; activity?: unknown; activity_ticks?: unknown }
    if (typeof data.tick !== 'number') return null
    const lines = Array.isArray(data.activity) ? data.activity : []
    const ticks = Array.isArray(data.activity_ticks) ? data.activity_ticks : []
    let reset: number | null = null
    for (let i = lines.length - 1; i >= 0; i--) {
      if (typeof lines[i] === 'string' && /campus reset/i.test(lines[i])) {
        reset = typeof ticks[i] === 'number' ? ticks[i] : 0
        break
      }
    }
    return { tick: data.tick, lines: lines.length, reset }
  } catch {
    return null
  }
}

/** The engine was reset between these two marks. */
export function resetSince(before: EngineMark, now: EngineMark): boolean {
  if (now.tick < before.tick || now.lines < before.lines) return true
  return now.reset !== null && now.reset !== before.reset
}

/** Failed node ids in a reply that carries the campus state, or null when it has none. */
export function downIn(data: unknown): Set<string> | null {
  const nodes = data && typeof data === 'object' ? (data as { nodes?: unknown }).nodes : null
  if (!Array.isArray(nodes)) return null
  const out = new Set<string>()
  for (const node of nodes) {
    if (node && typeof node === 'object' && (node as { failed?: unknown }).failed === true) {
      const id = (node as { id?: unknown }).id
      if (typeof id === 'string') out.add(id)
    }
  }
  return out
}

/** Take a whole U-M line out of service. */
export function suspendRoute(id: string, name: string): Promise<WeatherState> {
  return call('/storms/routes/suspend', { id, name })
}

export function restoreRoute(id: string): Promise<WeatherState> {
  return call('/storms/routes/restore', { id })
}
