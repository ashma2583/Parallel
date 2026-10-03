/** Shared colour / label helpers for node status and type. */

export type Status = 'Green' | 'Amber' | 'Red'

export const STATUS_COLOR: Record<Status, string> = {
  Green: '#3ddc97',
  Amber: '#ffb224',
  Red: '#ff5d5d',
}

export const STATUS_LABEL: Record<Status, string> = {
  Green: 'Full power',
  Amber: 'Reduced',
  Red: 'Dark',
}

export function statusColor(status: string): string {
  return STATUS_COLOR[status as Status] ?? '#596070'
}

export const TYPE_LABEL: Record<string, string> = {
  substation: 'Feed',
  hospital: 'Hospital',
  dorm: 'Dorm',
  dining: 'Commons',
  library: 'Library',
  transit: 'Transit',
  academic: 'Academic',
  research: 'Research',
  civic: 'City',
}

/** Icons drawn in a 20-unit box centred on the origin. */
export const TYPE_ICON: Record<string, string> = {
  substation: 'M2 -9 L-6 2 H-1 L-3 9 L6 -2 H1 Z',
  hospital: 'M-3 -8 H3 V-3 H8 V3 H3 V8 H-3 V3 H-8 V-3 H-3 Z',
  dorm: 'M-8 0 L0 -8 L8 0 V8 H2 V3 H-2 V8 H-8 Z',
  dining: 'M-7 -6 H7 V1 A7 6 0 0 1 -7 1 Z M-5 8 H5 V9.5 H-5 Z',
  library: 'M-8 -7 H-1 V7 H-8 Z M1 -7 H8 V7 H1 Z',
  transit: 'M-7 -8 H7 V4 H-7 Z M-6 5.5 H-3 V8.5 H-6 Z M3 5.5 H6 V8.5 H3 Z',
  academic: 'M-8 -3 L0 -8 L8 -3 Z M-7 -1 H-4 V5 H-7 Z M-1.5 -1 H1.5 V5 H-1.5 Z M4 -1 H7 V5 H4 Z M-8 6.5 H8 V8.5 H-8 Z',
  research: 'M-2.5 -8 H2.5 V-2 L7 8 H-7 L-2.5 -2 Z',
  civic: 'M-6 -8 H-4 V8 H-6 Z M-4 -8 L7 -4 L-4 0 Z',
}

export const PRIORITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'Supply',
}

export function fmtKw(n: number): string {
  return `${Math.round(n)} kW`
}

export function fmtPeople(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function fmtPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}
