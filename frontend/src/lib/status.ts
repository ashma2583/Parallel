/** Shared colour / label helpers for node status and type. */

export type Status = 'Green' | 'Amber' | 'Red'

export const STATUS_COLOR: Record<Status, string> = {
  Green: '#22c55e',
  Amber: '#f59e0b',
  Red: '#ef4444',
}

export function statusColor(status: string): string {
  return STATUS_COLOR[status as Status] ?? '#64748b'
}

/** Buildings this allocation tries to keep. A dead feed can still leave them dark. */
export function isProtected(type: string, priority: string, preference: string): boolean {
  if (preference === 'dorms') return type === 'dorm'
  if (preference === 'academic') return type === 'academic' || type === 'library'
  return type === 'hospital' && priority === 'critical'
}

export function planLabel(preference: string): string {
  if (preference === 'dorms') return 'Plan: keep dorms'
  if (preference === 'academic') return 'Plan: keep classes'
  return 'Plan: hospital only'
}

export const TYPE_LABEL: Record<string, string> = {
  substation: 'FEED',
  hospital: 'HOSPITAL',
  dorm: 'DORM',
  dining: 'COMMONS',
  library: 'LIBRARY',
  transit: 'TRANSIT',
  academic: 'ACADEMIC',
  research: 'RESEARCH',
  civic: 'CITY',
}

export const TYPE_GLYPH: Record<string, string> = {
  substation: '⚡',
  hospital: '✚',
  dorm: '⌂',
  dining: '◍',
  library: '▤',
  transit: '◉',
  academic: '▣',
  research: '🔬',
  civic: '⚑',
}

export const PRIORITY_LABEL: Record<string, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MED',
  low: 'LOW',
  none: 'SUPPLY',
}

export function fmtKw(n: number): string {
  return `${Math.round(n * 10) / 10} kW`
}
