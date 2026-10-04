/** Energy saver: caps on buildings by time of day, from backend/savings.py. */
import { BACKEND_URL } from '../config'

export type SaverPolicy = 'comfort' | 'balanced' | 'aggressive'
export const SAVER_POLICIES: SaverPolicy[] = ['comfort', 'balanced', 'aggressive']
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/** The saver running on the live clock. Carried on /state and /activity. */
export interface SaverLive {
  policy: SaverPolicy
  policy_label: string
  weekday: string
  minute: number
  clock: string
  slot: number
  caps: Record<string, number>
  until: Record<string, string>
  kw_saved_now: number
  kwh_saved: number
  people_capped: number
}

export interface SaverBuilding {
  id: string
  name: string
  type: string
  demand: number
  never: boolean
  managed: boolean
  source: string
  measured: boolean
  busyness: number[]
  people: number[]
  need: number[]
  limit: number[]
  kw_saved: number[]
  kwh_saved: number
}

export interface SaverTotals {
  kwh_always_on: number
  kwh_timeclock: number
  kwh_saver: number
  kwh_saved: number
  kwh_saved_vs_timeclock: number
  peak_kw_always_on: number
  peak_kw_saver: number
  peak_kw_cut: number
  buildings_capped: number
  people_capped_peak: number
  person_hours_capped: number
  pct_saved: number
}

export interface SaverPlan {
  campus_name: string
  weekday: string
  policy: SaverPolicy
  policy_label: string
  policies: Record<SaverPolicy, { label: string; description: string; headroom: number; precondition: number; types: string[] }>
  slots: { slot: number; minute: number; label: string }[]
  buildings: SaverBuilding[]
  series: { always_on_kw: number[]; saver_kw: number[]; timeclock_kw: number[] }
  totals: SaverTotals
  insight: string
  measured: boolean
  assumptions: string[]
  live: SaverLive | null
}

export interface SaverBranch {
  id: 'off' | SaverPolicy
  label: string
  description: string
  metrics: {
    kwh_saved: number
    essential_served: number
    critical_served: number
    people_dark: number
    meets_need: boolean
    eligible: boolean
    rank: number
  }
}

export interface SaverCompare {
  start: string
  end: string
  weekday: string
  winner: string
  branches: SaverBranch[]
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text().catch(() => '')}`)
  return res.json() as Promise<T>
}

export const fetchSaverPlan = (weekday: string, policy: SaverPolicy, campus = 'umich') =>
  call<SaverPlan>(`/savings/plan?weekday=${weekday}&policy=${policy}&campus=${encodeURIComponent(campus)}`)

export const applySaver = (policy: SaverPolicy, weekday: string, start_minute: number) =>
  call<{ live: SaverLive | null }>('/savings/apply', { policy, weekday, start_minute })

export const clearSaver = () => call<{ live: null }>('/savings/clear', {})

export const compareSaver = (weekday: string, start_minute: number) =>
  call<SaverCompare>('/branch', { mode: 'saver', weekday, start_minute })

export const hhmm = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

export interface SaverCampus {
  id: string
  name: string
  measured: boolean
}

export const fetchSaverCampuses = () => call<{ campuses: SaverCampus[] }>('/savings/campuses').then((r) => r.campuses)
