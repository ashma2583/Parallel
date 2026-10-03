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

export async function fetchActivity(): Promise<string[]> {
  const res = await fetch(`${BACKEND_URL}/activity`)
  if (!res.ok) return []
  const data = await res.json()
  return (data.lines ?? []) as string[]
}
