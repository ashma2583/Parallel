/**
 * Thin client for the FastAPI simulation engine. Writes go here; reads come
 * from SpacetimeDB subscriptions, with `/state` as the fallback when
 * SpacetimeDB is not reachable.
 */
import { BACKEND_URL } from '../config'
import { fromApiNode, type ApiNode, type SimNode } from './sim'
import { reducerLive, sendDefault } from './actions'
import type { ScenarioBatch } from './weather/forecast'

export type DisruptAction = 'fail' | 'restore' | 'derate'

async function post(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${path} -> ${res.status} ${text}`)
  }
  return res.json()
}

export function startHeatWave() {
  return post('/heat-wave')
}

/**
 * Disrupt, reset and adopt go through the shared action queue when SpacetimeDB is
 * live and the engine is consuming it (every director sees the result). Otherwise
 * they are the plain REST calls, exactly as before.
 */
async function act(kind: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  if (!reducerLive()) return post(path, body)
  const res = await sendDefault(kind, body ?? {})
  if (!res.ok) throw new Error(`${path} -> ${res.restStatus ?? 'failed'} ${res.error ?? ''}`.trim())
  return res
}

export function disrupt(nodeIds: string[], action: DisruptAction = 'fail', reason?: string, factor?: number) {
  return act('disrupt', '/disrupt', { node_ids: nodeIds, action, reason, factor })
}

export function resetSim() {
  return act('reset', '/reset')
}

export function adoptStrategy(strategy: string) {
  return act('strategy', '/strategy', { strategy })
}

export interface BranchMetrics {
  essential_served: number
  critical_served: number
  total_served: number
  people_total: number
  people_full_power: number
  people_reduced_power: number
  people_dark: number
  people_relocated: number
  people_in_shelter: number
  shelter_kw: number
  buildings_dark: number
}

export interface Branch {
  id: string
  label: string
  description: string
  metrics: BranchMetrics
  nodes: SimNode[]
  log: string[]
}

export interface BranchResult {
  baseTick: number
  ticks: number
  active: string
  season: Season
  shelter?: 'cooling' | 'warming'
  throughPeak?: boolean
  /** Set when a planned scenario was played forward: how far each copy ran. */
  through?: 'scenario end' | 'heat peak'
  /** The copies started from the campus a scenario run puts back, not the live one. */
  fromBaseline?: boolean
  branches: Branch[]
}

/**
 * Fork the live state and run every response policy forward. With a scenario,
 * each copy also plays the planned hits at their ticks.
 */
export async function runBranches(ticks = 6, scenario?: ScenarioBatch[]): Promise<BranchResult> {
  const data = (await post('/branch', scenario?.length ? { ticks, scenario } : { ticks })) as {
    base_tick: number
    ticks: number
    active: string
    season?: Season
    shelter?: 'cooling' | 'warming'
    through_peak?: boolean
    through?: 'scenario end' | 'heat peak'
    from_baseline?: boolean
    branches: (Omit<Branch, 'nodes'> & { nodes: ApiNode[] })[]
  }
  return {
    baseTick: data.base_tick,
    ticks: data.ticks,
    active: data.active,
    season: data.season ?? 'fall',
    shelter: data.shelter ?? (data.season === 'summer' ? 'cooling' : 'warming'),
    throughPeak: data.through_peak ?? false,
    through: data.through,
    fromBaseline: data.from_baseline ?? false,
    branches: data.branches.map((b) => ({ ...b, nodes: b.nodes.map(fromApiNode) })),
  }
}

export async function fetchVerdict(body: {
  season: Season
  shelter?: 'cooling' | 'warming'
  winner: string
  policies: { id: string; label: string; people_dark: number; people_in_shelter: number; people_relocated: number; shelter_kw: number }[]
}): Promise<{ paragraph: string; source: string }> {
  return post('/verdict', body) as Promise<{ paragraph: string; source: string }>
}

export type Season = 'summer' | 'fall' | 'winter' | 'spring'

export interface Shelter {
  kind?: 'cooling' | 'warming'
  answer: string
  open: boolean
  places: { id: string; name: string; occupancy: number }[]
}

export interface Briefing {
  preference: string
  season?: Season
  disrupted: boolean
  displaced: number
  priority: {
    answer: string
    dorms_dark: number
    classrooms_dark: number
    dorms_lit: number
    classrooms_lit: number
  }
  buses: {
    answer: string
    reroute: { id: string; name: string; agency: string; skip: string[]; keep: string[] }[]
  }
  cooling: Shelter
  shelter?: Shelter
  heat_wave?: { step: number; span: number; minutes: number; total_minutes: number; plant: number; north: number } | null
  systems: { system: string; status: 'up' | 'down'; detail: string }[]
}

export interface Policy {
  action: string
  node_ids: string[]
  summary: string
  reason: string
  parser: string
  parser_error?: string
}

export interface CommandResult {
  transcript: string
  policy: Policy
  notes: string[]
}

export function sendCommand(text: string): Promise<CommandResult> {
  return post('/command', { text }) as Promise<CommandResult>
}

export async function sendVoice(blob: Blob): Promise<CommandResult> {
  const body = new FormData()
  const ext = blob.type.includes('mp4') ? 'm4a' : 'webm'
  body.append('file', blob, `speech.${ext}`)
  const res = await fetch(`${BACKEND_URL}/voice`, { method: 'POST', body })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : res.statusText
    throw new Error(detail)
  }
  return data as CommandResult
}

/** A natural hazard that could strike this campus. */
export interface Hazard {
  id: string
  name: string
  /** Plain words, e.g. "about 13 a year in this county". */
  how_often: string
  per_year: number | null
  risk_rating: string | null
  events: number | null
  events_years: string | null
  worst_local_event: { date?: string; summary?: string; magnitude?: string; source?: string } | null
  /** What this model assumes it does to the campus feeds. Null when it assumes nothing. */
  effect: WeatherEffect | null
  summary: string | null
  warning_time: string | null
  typical_duration: string | null
  /** What it does to a campus, from documented events. Each has its source. */
  consequences: { system: string; what: string; timescale?: string; source?: string }[]
  /** shelter | relocate | evacuate */
  people: string | null
  /** normal | reduced | suspended */
  transit: string | null
  /** The calls an emergency manager has to make, as tradeoffs. */
  decisions: string[]
  /** Common misconceptions: what this hazard does not do. */
  does_not: string[]
  precedents: { where: string; when: string; what: string; source?: string }[]
}

export interface HazardList {
  place: string
  sources: string
  hazards: Hazard[]
  weather: {
    available: boolean
    conditions: { temperature_f: number | null; wind: string | null; summary: string | null } | null
    alerts: WeatherAlert[]
    /** Hazard ids the National Weather Service has an active alert for right now. */
    active_hazards: string[]
  }
}

export async function fetchHazards(): Promise<HazardList | null> {
  const res = await fetch(`${BACKEND_URL}/hazards`)
  if (!res.ok) return null
  return res.json()
}

export function applyHazard(id: string) {
  return post('/hazards/apply', { id })
}

export interface WeatherEffect {
  label: string
  why: string
}

/** A National Weather Service alert, live or replayed from the archive. */
export interface WeatherAlert {
  id: string
  event: string
  headline: string
  what: string
  impacts?: string
  instruction: string
  issued: string | null
  expires: string | null
  office: string
  source?: string
  /** What this model assumes the weather does to the campus. Null when it assumes nothing. */
  effect: WeatherEffect | null
}

export interface Weather {
  available: boolean
  conditions: { temperature_f: number | null; wind: string | null; summary: string | null } | null
  alerts: WeatherAlert[]
  replays: WeatherAlert[]
}

export async function fetchWeather(): Promise<Weather | null> {
  const res = await fetch(`${BACKEND_URL}/weather`)
  if (!res.ok) return null
  return res.json()
}

export function applyWeather(id: string) {
  return post('/weather/apply', { id })
}

export async function fetchClock(): Promise<{ tick: number; paused: boolean }> {
  const res = await fetch(`${BACKEND_URL}/clock`)
  if (!res.ok) return { tick: 0, paused: false }
  return res.json()
}

export async function setClock(body: { paused?: boolean; until?: number; at?: string }): Promise<{ tick: number; paused: boolean }> {
  return post('/clock', body) as Promise<{ tick: number; paused: boolean }>
}

/** Students in class right now by building, at the engine's clock. The engine counts these in each building. */
export interface PeopleNow {
  slot: string | null
  weekday: string | null
  minutes: number
  driving: boolean
  total: number
  buildings: { node_id: string; name: string; students: number; present: number }[]
}

export async function fetchPeopleNow(): Promise<PeopleNow | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/people/now`)
    if (!res.ok) return null
    return (await res.json()) as PeopleNow
  } catch {
    return null
  }
}

/** Tell the engine which weekday and turnup the People tab shows, so its occupancy counts the same day. */
export async function selectPeople(weekday: string | undefined, turnup: number): Promise<void> {
  try {
    await post('/people/selection', weekday ? { weekday, turnup } : { turnup })
  } catch {
    // The tab still works without the engine.
  }
}

export async function setSeason(season: Season): Promise<Briefing> {
  return post('/season', { season }) as Promise<Briefing>
}

export interface PlanScores {
  optimal: number
  energy: number
  feasibility: number
  cost: number
  risk: number
  people: number
}

export interface ResponsePlan {
  rank: number
  title: string
  summary: string
  energy: string
  transit: string
  infrastructure: string
  intervention: string
  analysis: string
  apply: string | null
  scores: PlanScores
  total: number
}

export async function fetchPlans(): Promise<{ season: Season; plans: ResponsePlan[] }> {
  return post('/plans') as Promise<{ season: Season; plans: ResponsePlan[] }>
}

export interface Debrief {
  headline: string
  grid: string
  options: string[]
  buses: string
  solutions: string[]
  watch: string
}

export interface SurveyBuilding {
  name: string
  role: string
  why: string
  lat: number
  lng: number
  id?: string
  /** Id of the power source this building is assumed to be on. Null means its own supply. */
  feed?: string | null
  /** "map": placed from OpenStreetMap. "model": the language model's own guess. */
  located?: 'map' | 'model'
}

export interface SurveyLine {
  name: string
  agency: string
  connects: string
}

export interface LocationSurvey {
  name: string
  summary: string
  power?: { utility: string; on_campus_plant: string; how_it_is_fed: string }
  placement?: { checked: boolean; on_map?: number; from_model?: number; dropped?: string[]; note: string }
  buildings: SurveyBuilding[]
  transit: SurveyLine[]
  sources: string[]
}

export interface ProposalImpact {
  id: string
  name: string
  type: string
  people: number
  demand_kw: number
  received_kw: number
  status: string
  feeder: string
  feeder_label: string
  feeder_id: string
  supply_kw: number
  demand_before_kw: number
  demand_after_kw: number
  headroom_kw: number
  shed: string[]
  walks_to: string
  buses: { id: string; name: string }[]
  lat: number
  lng: number
}

export interface ProposalPin {
  id: string
  name: string
  type: string
  status: string
  lat: number
  lng: number
  feeder_id: string
  people: number
  demand_kw: number
  received_kw: number
}

export async function proposeBuilding(body: {
  name: string
  kind: string
  lng: number
  lat: number
  demand_kw: number
  people: number
}): Promise<ProposalImpact> {
  return post('/proposal', body) as Promise<ProposalImpact>
}

export async function removeProposal(id: string): Promise<void> {
  await postDelete(`/proposal/${id}`)
}

export async function fetchProposals(): Promise<ProposalPin[]> {
  const res = await fetch(`${BACKEND_URL}/proposals`)
  if (!res.ok) return []
  const data = await res.json()
  return (data.proposals ?? []) as ProposalPin[]
}

async function postDelete(path: string): Promise<unknown> {
  const res = await fetch(`${BACKEND_URL}${path}`, { method: 'DELETE' })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${path} -> ${res.status} ${text}`)
  }
  return res.json()
}

export async function researchLocation(query: string): Promise<LocationSurvey> {
  return post('/location', { query }) as Promise<LocationSurvey>
}

export async function fetchDebrief(): Promise<Debrief> {
  return post('/debrief') as Promise<Debrief>
}

export interface ClassSlot {
  minutes: number
  label: string
  students: number
  events?: number
}

export interface ClassBuilding {
  code: string
  name: string
  campus: string
  lat: number | null
  lng: number | null
  node_id: string | null
  students: number[]
}

export interface ClassLoad {
  weekday: string
  turnup: number
  focus: number
  note: string | null
  term: string
  term_name: string
  source: string
  source_label: string
  slots: ClassSlot[]
  buildings: ClassBuilding[]
  meeting_count: number
  event_count?: number
}

export interface ClassSpot {
  code: string
  name: string
  lat: number
  lng: number
  nodeId: string | null
  students: number
}

export async function fetchClassLoad(weekday?: string, turnup = 0.75): Promise<ClassLoad> {
  const params = new URLSearchParams({ turnup: String(turnup) })
  if (weekday) params.set('weekday', weekday)
  const res = await fetch(`${BACKEND_URL}/occupancy?${params}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : res.statusText
    throw new Error(detail)
  }
  return data as ClassLoad
}
