/**
 * Thin client for the FastAPI simulation engine. Writes go here; reads come
 * from SpacetimeDB subscriptions, with `/state` as the fallback when
 * SpacetimeDB is not reachable.
 */
import { BACKEND_URL } from '../config'
import { fromApiNode, type ApiNode, type SimNode } from './sim'

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

export function disrupt(nodeIds: string[], action: DisruptAction = 'fail', reason?: string, factor?: number) {
  return post('/disrupt', { node_ids: nodeIds, action, reason, factor })
}

export function resetSim() {
  return post('/reset')
}

export function adoptStrategy(strategy: string) {
  return post('/strategy', { strategy })
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
  branches: Branch[]
}

/** Fork the live state and run every response policy forward. */
export async function runBranches(ticks = 6): Promise<BranchResult> {
  const data = (await post('/branch', { ticks })) as {
    base_tick: number
    ticks: number
    active: string
    branches: (Omit<Branch, 'nodes'> & { nodes: ApiNode[] })[]
  }
  return {
    baseTick: data.base_tick,
    ticks: data.ticks,
    active: data.active,
    branches: data.branches.map((b) => ({ ...b, nodes: b.nodes.map(fromApiNode) })),
  }
}

export interface Briefing {
  preference: string
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
