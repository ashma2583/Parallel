import type { Map as MaplibreMap } from 'maplibre-gl'

/**
 * Weather drawn on the Ann Arbor map: a storm the director places by hand,
 * what it does to the campus, and what the engine remembers about it.
 *
 * Coordinates are [lng, lat] everywhere, the same order as GeoJSON.
 */

export type LngLat = [number, number]

export type StormKind =
  | 'tornado'
  | 'thunderstorm'
  | 'ice'
  | 'flood'
  | 'blizzard'
  | 'lightning'
  | 'blackout'
  | 'closure'

/** Weather, or a tool the director uses directly. The dock shows them as two groups. */
export type StormGroup = 'weather' | 'tool'

export interface StormSpec {
  kind: StormKind
  group: StormGroup
  /** "Tornado" */
  label: string
  /** Past tense for the feed: "touched down", "rolled in". */
  verb: string
  /** One label per intensity step, weakest first. */
  levels: string[]
  /** Footprint radius in meters for each level. */
  radius: number[]
  /** Run length per kilometer of track, in milliseconds. */
  msPerKm: number
  /** A click with no drag is allowed. Lightning only takes a click. */
  input: 'path' | 'point' | 'both'
  /** What it does here, in one line for the dock. */
  blurb: string
  /** Accent for the dock chip and the draft swath. Never a building-state colour. */
  accent: string
}

export const STORM_SPECS: Record<StormKind, StormSpec> = {
  tornado: {
    kind: 'tornado',
    group: 'weather',
    label: 'Tornado',
    verb: 'touched down',
    levels: ['EF1', 'EF2', 'EF3', 'EF4'],
    radius: [110, 170, 240, 330],
    msPerKm: 2200,
    input: 'path',
    blurb: 'Destroys what is in its path. Buildings, lines and roads it crosses go down.',
    accent: '#c9b8a6',
  },
  thunderstorm: {
    kind: 'thunderstorm',
    group: 'weather',
    label: 'Thunderstorm',
    verb: 'rolled in',
    levels: ['Strong', 'Severe', 'Derecho'],
    radius: [650, 950, 1400],
    msPerKm: 1500,
    input: 'both',
    blurb: 'Wind brings down trees and overhead lines. Central Campus is fed underground.',
    accent: '#5eead4',
  },
  ice: {
    kind: 'ice',
    group: 'weather',
    label: 'Ice storm',
    verb: 'glazed',
    levels: ['Glaze', 'Ice storm', 'Crippling'],
    radius: [900, 1300, 1900],
    msPerKm: 1800,
    input: 'both',
    blurb: 'Ice loads overhead lines until they snap, and closes roads.',
    accent: '#bae6fd',
  },
  flood: {
    kind: 'flood',
    group: 'weather',
    label: 'Flash flood',
    verb: 'flooded',
    levels: ['Minor', 'Moderate', 'Major'],
    radius: [220, 380, 600],
    msPerKm: 2000,
    input: 'both',
    blurb: 'Water reaches basement switchgear and covers roads.',
    accent: '#60a5fa',
  },
  blizzard: {
    kind: 'blizzard',
    group: 'weather',
    label: 'Blizzard',
    verb: 'buried',
    levels: ['Heavy snow', 'Blizzard', 'Whiteout'],
    radius: [1000, 1500, 2200],
    msPerKm: 1400,
    input: 'both',
    blurb: 'Buses stop. Wet snow loads the overhead feeds.',
    accent: '#e2e8f0',
  },
  lightning: {
    kind: 'lightning',
    group: 'weather',
    label: 'Lightning',
    verb: 'struck',
    levels: ['Strike', 'Strong', 'Superbolt'],
    radius: [90, 140, 200],
    msPerKm: 0,
    input: 'point',
    blurb: 'Strikes the nearest building or feed and takes it offline.',
    accent: '#fde68a',
  },
  blackout: {
    kind: 'blackout',
    group: 'tool',
    label: 'Cut power',
    verb: 'cut power to',
    levels: ['Block', 'District', 'Wide'],
    radius: [150, 350, 700],
    msPerKm: 900,
    input: 'both',
    blurb: 'Everything inside goes dark. Lines through it are cut.',
    accent: '#a5b4fc',
  },
  closure: {
    kind: 'closure',
    group: 'tool',
    label: 'Close roads',
    verb: 'closed',
    levels: ['Lane', 'Street', 'Corridor'],
    radius: [40, 80, 140],
    msPerKm: 900,
    input: 'path',
    blurb: 'Bus lines and roads through it are closed.',
    accent: '#fca5a5',
  },
}

export const STORM_KINDS = Object.keys(STORM_SPECS) as StormKind[]

/** How fast a storm plays out, as a multiple of its natural pace. */
export const RUN_SPEEDS = [0.5, 1, 2] as const

/** One storm, as drawn. A single point is a storm that stays where it was dropped. */
export interface Storm {
  id: string
  kind: StormKind
  /** Index into the spec's levels. */
  level: number
  path: LngLat[]
  /** Meters. */
  radius: number
  /** "EF3 tornado" */
  label: string
}

export type ImpactTarget = 'building' | 'feed' | 'line' | 'bus' | 'road'
export type ImpactAction = 'fail' | 'derate' | 'cut' | 'close'

/** Something the storm does, and the moment in its run when it does it. */
export interface Impact {
  /** Unique within a storm, e.g. "building:markley", "bus:CN". */
  key: string
  /** Progress through the run (0..1) when this lands. */
  t: number
  target: ImpactTarget
  action: ImpactAction
  /** Where the hit is drawn. */
  at: LngLat
  /** "Mary Markley Hall", "Commuter North", "Central Power Plant → South Quad". */
  label: string
  /** "direct hit", "line down", "trees across the road". */
  detail: string
  /** Nodes to fail (action fail or cut) or derate. Empty when nothing new goes down. */
  nodeIds: string[]
  /** Output fraction for action derate. */
  factor?: number
  /** Power edge cut, or road edge closed. */
  edgeId?: string
  /** Closed stretches of a bus line, for action close on target bus. */
  route?: { id: string; name: string; segments: LngLat[][] }
}

export interface ImpactCounts {
  buildings: number
  feeds: number
  lines: number
  buses: number
  roads: number
}

/** A storm the engine has on record. Same shape as Storm, plus where it is in its run. */
export interface StormRecord extends Storm {
  status: 'active' | 'done'
}

/** A bus line out of service. Null segments means the whole line. */
export interface ClosedRoute {
  id: string
  name: string
  segments: LngLat[][] | null
  reason: string
  storm_id?: string | null
}

/** A power edge cut, or a road edge closed, and where. */
export interface EdgeMark {
  id: string
  at: LngLat
  storm_id?: string | null
}

/** What the engine knows about weather on the campus. Served in the briefing as `weather`. */
export interface WeatherState {
  storms: StormRecord[]
  closed_routes: ClosedRoute[]
  cut_edges: EdgeMark[]
  closed_roads: EdgeMark[]
}

export const EMPTY_WEATHER: WeatherState = { storms: [], closed_routes: [], cut_edges: [], closed_roads: [] }

/** A U-M bus line shape, one direction. */
export interface BusLine {
  id: string
  name: string
  coords: LngLat[]
}

// ---------------------------------------------------------------------------
// Props shared by the controller hook, the canvas and the dock.
// ---------------------------------------------------------------------------

/** A storm running on screen right now. Progress is derived from the clock, not passed in. */
export interface LiveStorm {
  storm: Storm
  impacts: Impact[]
  /** performance.now() when the run began. */
  startedAt: number
  /** Milliseconds. */
  duration: number
}

/** The path being drawn, before the pointer is released. */
export interface DraftStorm {
  kind: StormKind
  level: number
  radius: number
  path: LngLat[]
}

/** Persistent marks: a closed stretch of bus line, a cut power line, a closed road. */
export interface MapMark {
  key: string
  kind: 'bus' | 'line' | 'road'
  at: LngLat
}

export type DockPhase = 'idle' | 'armed' | 'drawing' | 'running' | 'done'

/** The ghost footprint under the cursor while a kind is armed. */
export interface HoverStorm {
  kind: StormKind
  level: number
  radius: number
  at: LngLat
}

export interface WeatherCanvasProps {
  map: MaplibreMap | null
  /** Finished storms on record. Drawn as their lasting footprint. */
  tracks: StormRecord[]
  /** Storms running right now. Several can overlap in a scenario. */
  live: LiveStorm[]
  draft: DraftStorm | null
  hover: HoverStorm | null
  marks: MapMark[]
  /** Drawn events in the scenario plan that have not started in the current run. */
  staged: StagedStorm[]
  selectedId: string | null
  /** Campus-wide conditions that have arrived in the current run. */
  campus: CampusEffect[]
}

/** What the storm being drawn would do if released now. */
export interface DockPreview {
  lengthKm: number
  /** "north-east", or null for a storm dropped in place. */
  heading: string | null
  counts: ImpactCounts
  impacts: Impact[]
}

export interface WeatherDockProps {
  open: boolean
  onOpen: (open: boolean) => void
  /** The armed drawing kind, or null. */
  kind: StormKind | null
  level: number
  onKind: (kind: StormKind | null) => void
  onLevel: (level: number) => void
  phase: DockPhase
  preview: DockPreview | null
  /** The scenario plan, in start order. */
  events: ScenarioEvent[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onUpdate: (id: string, patch: EventPatch) => void
  onRemove: (id: string) => void
  onAddHazard: (hazard: HazardKind) => void
  onAddFault: (fault: FaultKind) => void
  onRun: () => void
  onStop: () => void
  /** Empty the plan. The campus stays as it is. */
  onClear: () => void
  /** The scenario clock while a run plays. Total is the whole run in ms at the current speed. */
  run: { startedAt: number; total: number } | null
  /** The plan changed since the last run finished, so the map no longer shows it. */
  stale: boolean
  live: LiveStorm[]
  /** Hits landed so far in the current or last run, oldest first. */
  landed: Impact[]
  /** Summary of the last finished run. */
  last: { label: string; counts: ImpactCounts } | null
  /** Storms on record since the last reset. */
  history: StormRecord[]
  /** Run speed multiplier, one of RUN_SPEEDS. */
  speed: number
  onSpeed: (speed: number) => void
  /** The engine has no /storms routes (not restarted yet). Hits still apply through /disrupt. */
  degraded: boolean
  error: string | null
}

// ---------------------------------------------------------------------------
// Scenario plan: weather drawn on the map, campus-wide conditions, and grid
// faults, stacked on one clock and run together.
// ---------------------------------------------------------------------------

/** Conditions that cover the whole campus. No path to draw. */
export type HazardKind = 'heat' | 'cold' | 'wind'

export interface HazardSpec {
  kind: HazardKind
  label: string
  /** Id in the engine's hazard list, applied with POST /hazards/apply. */
  hazardId: string
  blurb: string
  accent: string
}

export const HAZARD_SPECS: Record<HazardKind, HazardSpec> = {
  heat: { kind: 'heat', label: 'Extreme heat', hazardId: 'extreme_heat', blurb: 'The utility calls for cuts while cooling demand peaks. Both feeds run at 70%.', accent: '#fdba74' },
  cold: { kind: 'cold', label: 'Extreme cold', hazardId: 'extreme_cold', blurb: 'Gas is curtailed. The power plant runs at 60%.', accent: '#93c5fd' },
  wind: { kind: 'wind', label: 'High wind', hazardId: 'high_wind', blurb: 'Trees fall on the overhead feed into North Campus. It runs at 50%.', accent: '#cbd5e1' },
}

/** Equipment that breaks with no weather involved. */
export type FaultKind = 'cpp' | 'north' | 'hospital' | 'intakes'

export interface FaultSpec {
  kind: FaultKind
  label: string
  detail: string
  /** Logged to the agent feed as the reason. */
  reason: string
  nodeIds: string[]
}

export const FAULT_SPECS: Record<FaultKind, FaultSpec> = {
  cpp: { kind: 'cpp', label: 'Power plant trips', detail: 'Central campus loses its only feed', reason: 'Central campus generation trips offline', nodeIds: ['cpp'] },
  north: { kind: 'north', label: 'North feed opens', detail: 'Only NCRC has generation of its own', reason: 'DTE campus substation feed opens', nodeIds: ['north_switch'] },
  hospital: { kind: 'hospital', label: 'Hospital switchgear', detail: 'Medical campus falls back to the emergency tie', reason: 'University Hospital intake fails', nodeIds: ['uh'] },
  intakes: { kind: 'intakes', label: 'All intakes drop', detail: 'Regional outage', reason: 'All three campus intakes drop', nodeIds: ['cpp', 'uh', 'north_switch'] },
}

interface EventBase {
  id: string
  /** Seconds after the run starts, at 1x speed. */
  start: number
}

export type ScenarioEvent =
  | (EventBase & { type: 'storm'; kind: StormKind; level: number; path: LngLat[] })
  | (EventBase & { type: 'hazard'; hazard: HazardKind })
  | (EventBase & { type: 'fault'; fault: FaultKind })

/** Fields the dock can change on an event. Kind and level apply to storms only. */
export interface EventPatch {
  start?: number
  kind?: StormKind
  level?: number
  path?: LngLat[]
}

/**
 * Sim time. Same convention as the team's heat-wave clock (origin/heat-wave-demo):
 * one engine tick is four minutes, fifteen ticks an hour. At 1x a tick is one real
 * second, so a scenario second is four sim minutes.
 */
export const TICK_MINUTES = 4
export const TICKS_PER_HOUR = 60 / TICK_MINUTES

/** "14:00" plus `seconds` of run at 1x, as a clock time. */
export function simClock(startsAt: string, seconds: number): string {
  const [h, m] = startsAt.split(':').map(Number)
  const total = (Number.isFinite(h) ? h : 14) * 60 + (Number.isFinite(m) ? m : 0) + Math.round(seconds * TICK_MINUTES)
  const day = ((total % 1440) + 1440) % 1440
  return `${String(Math.floor(day / 60)).padStart(2, '0')}:${String(day % 60).padStart(2, '0')}`
}

export interface ScenarioPlan {
  events: ScenarioEvent[]
  /** Clock time the scenario starts at, "HH:MM". Building occupancy by time of day will key off this. */
  startsAt: string
}

/** A drawn event in the plan, ready to draw as a ghost. */
export interface StagedStorm {
  id: string
  /** 1-based position in the plan, shown as a badge. */
  index: number
  kind: StormKind
  level: number
  radius: number
  path: LngLat[]
  start: number
}

/** A campus-wide condition arriving. The arrival animation runs for `duration`, then it lingers faintly. */
export interface CampusEffect {
  id: string
  hazard: HazardKind
  /** performance.now() when it arrived. */
  startedAt: number
  duration: number
}

/** Something outside the map asking the dock to open: arm a drawing kind, or add a condition or fault. */
export interface WeatherRequest {
  seq: number
  kind?: StormKind
  hazard?: HazardKind
  fault?: FaultKind
}
