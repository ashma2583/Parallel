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
