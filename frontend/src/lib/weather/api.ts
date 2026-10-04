/**
 * Client for the engine's weather routes. An engine that predates them answers
 * 404 or 405, which comes back as NoStormRoutes so the caller can fall back to
 * /disrupt and keep the weather in the browser. A hit or end for a storm from
 * before the last scenario run answers 409; that is expected and comes back as null.
 */
import { BACKEND_URL } from '../../config'
import { EMPTY_WEATHER, type ClosedRoute, type EdgeMark, type LngLat, type StormKind, type WeatherState } from './types'

export class NoStormRoutes extends Error {
  constructor() {
    super('The engine has no weather routes yet. Restart it to keep storms on record.')
    this.name = 'NoStormRoutes'
  }
}

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

/** Null when the storm is from before the last scenario run; the hit is dropped. */
export function hitStorm(hit: StormHit): Promise<WeatherState | null> {
  return callLive('/storms/hit', hit)
}

export function endStorm(stormId: string, summary: string): Promise<WeatherState | null> {
  return callLive('/storms/end', { storm_id: stormId, summary })
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
