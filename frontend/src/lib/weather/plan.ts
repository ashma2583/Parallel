/**
 * The scenario plan as data: what each event is called, how long it runs,
 * where the next one starts, and how the plan is kept between visits.
 * Pure apart from loadPlan and savePlan, which touch localStorage.
 */
import { runDuration } from './geo'
import { stormLabel } from './impacts'
import {
  FAULT_SPECS,
  HAZARD_SPECS,
  STORM_SPECS,
  type EventPatch,
  type FaultKind,
  type HazardKind,
  type LngLat,
  type ScenarioEvent,
  type ScenarioPlan,
  type StagedStorm,
  type StormKind,
} from './types'

export const PLAN_KEY = 'parallel-scenario'
export const DEFAULT_STARTS_AT = '14:00'

/** A campus-wide condition takes this long to arrive, at 1x. */
export const HAZARD_MS = 2600
/** An equipment fault plays for this long, at 1x. */
export const FAULT_MS = 1600
/** Default starts snap up to this step, in seconds, so the plan reads in round numbers. */
const START_STEP = 0.5

export type StormEvent = Extract<ScenarioEvent, { type: 'storm' }>

export const EMPTY_PLAN: ScenarioPlan = { events: [], startsAt: DEFAULT_STARTS_AT }

let counter = 0

export function eventId(): string {
  counter = (counter + 1) % 1296
  return `ev-${Date.now().toString(36)}-${counter.toString(36)}`
}

export function radiusOf(kind: StormKind, level: number): number {
  const r = STORM_SPECS[kind].radius
  return r[clampLevel(kind, level)]
}

export function clampLevel(kind: StormKind, level: number): number {
  const top = STORM_SPECS[kind].levels.length - 1
  return Math.max(0, Math.min(top, Math.round(Number.isFinite(level) ? level : 0)))
}

/** How long an event plays, in ms at 1x. Divide by the run speed for the real length. */
export function eventMs(e: ScenarioEvent): number {
  if (e.type === 'storm') return runDuration(e.kind, e.path, STORM_SPECS[e.kind].msPerKm)
  return e.type === 'hazard' ? HAZARD_MS : FAULT_MS
}

/** "EF3 tornado", "Extreme heat", "Power plant trips". */
export function eventLabel(e: ScenarioEvent): string {
  if (e.type === 'storm') return stormLabel(e.kind, e.level)
  return e.type === 'hazard' ? HAZARD_SPECS[e.hazard].label : FAULT_SPECS[e.fault].label
}

/** Where a new event starts: once everything already planned has played out. */
export function nextStart(events: readonly ScenarioEvent[]): number {
  let end = 0
  for (const e of events) end = Math.max(end, e.start + eventMs(e) / 1000)
  return round(Math.ceil(end / START_STEP - 1e-6) * START_STEP)
}

/** Whole run in ms at a speed: the last thing to finish. */
export function planTotal(events: readonly ScenarioEvent[], speed: number): number {
  let total = 0
  for (const e of events) total = Math.max(total, (e.start * 1000 + eventMs(e)) / speed)
  return total
}

/** By start time; events starting together keep the order they were added in. */
export function sortEvents(events: readonly ScenarioEvent[]): ScenarioEvent[] {
  return events
    .map((e, i) => [e, i] as const)
    .sort((a, b) => a[0].start - b[0].start || a[1] - b[1])
    .map(([e]) => e)
}

export function stormEvent(kind: StormKind, level: number, path: LngLat[], start: number): StormEvent {
  return { id: eventId(), type: 'storm', kind, level: clampLevel(kind, level), path, start }
}

export function hazardEvent(hazard: HazardKind, start: number): ScenarioEvent {
  return { id: eventId(), type: 'hazard', hazard, start }
}

export function faultEvent(fault: FaultKind, start: number): ScenarioEvent {
  return { id: eventId(), type: 'fault', fault, start }
}

/**
 * Apply a dock edit to one event. Returns the event unchanged with a hint when
 * the edit cannot apply, e.g. a tornado on a storm that was dropped in place.
 */
export function patchEvent(e: ScenarioEvent, patch: EventPatch, levelFor: (kind: StormKind) => number): { event: ScenarioEvent; hint?: string } {
  let next: ScenarioEvent = e
  if (patch.start !== undefined && Number.isFinite(patch.start)) next = { ...next, start: round(Math.max(0, patch.start)) }
  if (next.type !== 'storm') return { event: next }
  let hint: string | undefined
  if (patch.path && patch.path.length > 0) next = { ...next, path: patch.path }
  if (patch.kind && patch.kind !== next.kind) {
    const spec = STORM_SPECS[patch.kind]
    if (spec.input === 'path' && next.path.length < 2) {
      hint = `${spec.label} needs a path. Draw one on the map.`
    } else {
      next = { ...next, kind: patch.kind, level: clampLevel(patch.kind, patch.level ?? levelFor(patch.kind)) }
    }
  } else if (patch.level !== undefined) {
    next = { ...next, level: clampLevel(next.kind, patch.level) }
  }
  if (STORM_SPECS[next.kind].input === 'point' && next.path.length > 1) next = { ...next, path: [next.path[0]] }
  return { event: next, hint }
}

/** Every point moved by the same lng/lat offset. */
export function translatePath(path: readonly LngLat[], dLng: number, dLat: number): LngLat[] {
  return path.map(([lng, lat]) => [lng + dLng, lat + dLat])
}

/** Drawn events as ghosts for the canvas. Index is the 1-based position in the whole plan. */
export function stagedOf(events: readonly ScenarioEvent[], skip?: ReadonlySet<string>): StagedStorm[] {
  const out: StagedStorm[] = []
  events.forEach((e, i) => {
    if (e.type !== 'storm' || skip?.has(e.id)) return
    out.push({ id: e.id, index: i + 1, kind: e.kind, level: e.level, radius: radiusOf(e.kind, e.level), path: e.path, start: e.start })
  })
  return out
}

/** "EF3 tornado + Extreme heat", "EF3 tornado + Extreme heat +2 more". */
export function planNames(events: readonly ScenarioEvent[]): string {
  const names = events.slice(0, 2).map(eventLabel)
  const more = events.length - names.length
  return names.join(' + ') + (more > 0 ? ` +${more} more` : '')
}

/** Minutes on the scenario clock after `elapsedMs` of run. One second of run is one minute at 1x. */
export function simMinutes(elapsedMs: number, speed: number): number {
  return Math.max(0, (elapsedMs / 1000) * speed)
}

/** "14:00" plus some minutes, wrapping past midnight. */
export function clockAt(startsAt: string, minutes: number): string {
  const [h, m] = parseClock(startsAt) ?? [14, 0]
  const total = (((h * 60 + m + Math.floor(minutes)) % 1440) + 1440) % 1440
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

export function parseClock(value: string): [number, number] | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  return h < 24 && m < 60 ? [h, m] : null
}

// ---- storage ---------------------------------------------------------------

export function loadPlan(): ScenarioPlan {
  try {
    const raw = window.localStorage.getItem(PLAN_KEY)
    if (!raw) return EMPTY_PLAN
    return asPlan(JSON.parse(raw))
  } catch {
    return EMPTY_PLAN
  }
}

export function savePlan(plan: ScenarioPlan): void {
  try {
    window.localStorage.setItem(PLAN_KEY, JSON.stringify(plan))
  } catch {
    // Private window or storage full: the plan lives for this visit only.
  }
}

/** A stored plan, keeping only the events that still make sense. */
export function asPlan(raw: unknown): ScenarioPlan {
  if (!raw || typeof raw !== 'object') return EMPTY_PLAN
  const r = raw as { events?: unknown; startsAt?: unknown }
  const startsAt = typeof r.startsAt === 'string' && parseClock(r.startsAt) ? normalizeClock(r.startsAt) : DEFAULT_STARTS_AT
  const events: ScenarioEvent[] = []
  const ids = new Set<string>()
  for (const item of Array.isArray(r.events) ? r.events : []) {
    const e = asEvent(item)
    if (e && !ids.has(e.id)) {
      ids.add(e.id)
      events.push(e)
    }
  }
  return { events: sortEvents(events), startsAt }
}

function asEvent(raw: unknown): ScenarioEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (typeof e.id !== 'string' || !e.id || typeof e.start !== 'number' || !Number.isFinite(e.start)) return null
  const base = { id: e.id, start: round(Math.max(0, e.start)) }
  if (e.type === 'hazard') return typeof e.hazard === 'string' && e.hazard in HAZARD_SPECS ? { ...base, type: 'hazard', hazard: e.hazard as HazardKind } : null
  if (e.type === 'fault') return typeof e.fault === 'string' && e.fault in FAULT_SPECS ? { ...base, type: 'fault', fault: e.fault as FaultKind } : null
  if (e.type !== 'storm' || typeof e.kind !== 'string' || !(e.kind in STORM_SPECS)) return null
  const kind = e.kind as StormKind
  if (!Array.isArray(e.path) || e.path.length === 0 || e.path.length > 400) return null
  const path: LngLat[] = []
  for (const p of e.path) {
    if (!Array.isArray(p) || p.length < 2) return null
    const [lng, lat] = p
    if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)) return null
    if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return null
    path.push([lng, lat])
  }
  const input = STORM_SPECS[kind].input
  if (input === 'path' && path.length < 2) return null
  const level = typeof e.level === 'number' ? e.level : 0
  return { ...base, type: 'storm', kind, level: clampLevel(kind, level), path: input === 'point' ? [path[0]] : path }
}

function normalizeClock(value: string): string {
  const [h, m] = parseClock(value) ?? [14, 0]
  return `${pad(h)}:${pad(m)}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
