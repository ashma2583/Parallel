/**
 * Thin client for the FastAPI simulation engine. Writes go here; reads come
 * from SpacetimeDB subscriptions (never poll the backend for state).
 */
import { BACKEND_URL } from '../config'

export type DisruptAction = 'fail' | 'restore'

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

export function disrupt(nodeIds: string[], action: DisruptAction = 'fail', reason?: string) {
  return post('/disrupt', { node_ids: nodeIds, action, reason })
}

export function resetSim() {
  return post('/reset')
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

export type PriorityMode = 'balanced' | 'dorms' | 'academic'

export interface Briefing {
  preference: PriorityMode
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
  cooling: {
    answer: string
    open: boolean
    places: { id: string; name: string; occupancy: number }[]
  }
  systems: { system: string; status: 'up' | 'down'; detail: string }[]
}

export async function fetchBriefing(): Promise<Briefing | null> {
  const res = await fetch(`${BACKEND_URL}/briefing`)
  if (!res.ok) return null
  return res.json()
}

export async function setPriority(mode: PriorityMode): Promise<Briefing> {
  return post('/priority', { mode }) as Promise<Briefing>
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
}

export interface SurveyLine {
  name: string
  agency: string
  connects: string
}

export interface LocationSurvey {
  name: string
  summary: string
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

export async function fetchActivity(): Promise<string[]> {
  const res = await fetch(`${BACKEND_URL}/activity`)
  if (!res.ok) return []
  const data = await res.json()
  return (data.lines ?? []) as string[]
}
