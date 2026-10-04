/**
 * Contract between the weather canvas and the per-kind renderers.
 * The canvas projects, clears and calls; a renderer only paints.
 */
import type { StormKind } from '../../../lib/weather/types'

export interface Pt {
  x: number
  y: number
}

export interface Frame {
  ctx: CanvasRenderingContext2D
  /** CSS pixels. The context is already scaled for devicePixelRatio. */
  width: number
  height: number
  /** performance.now() for this frame. Ambient motion keys off this. */
  now: number
  /** Dark console theme (inverted dark basemap) or light. */
  dark: boolean
  /** Screen pixels per meter at the map centre. */
  pxPerMeter: number
}

/** The footprint the storm has swept so far. Drawn under the storm cell. */
export interface TrackArgs {
  kind: StormKind
  level: number
  /** Projected path, full length. */
  path: Pt[]
  /** Projected path cut off at the storm head (equals path once finished). */
  swept: Pt[]
  radiusPx: number
  /** True while the storm is still running; false for a finished storm on record. */
  live: boolean
  /** Stable per storm, for seeded noise. */
  seed: number
  /** ms since the run started (live), or since the page drew it (finished). */
  age: number
}

/** The storm itself, where it is right now. */
export interface CellArgs {
  kind: StormKind
  level: number
  head: Pt
  /** Screen-space direction of travel, radians (atan2(dy, dx)). 0 when stationary. */
  heading: number
  /** True when dropped with a click rather than dragged. */
  stationary: boolean
  /** Current radius in px: grows in for a stationary storm, eases in/out at touchdown and dissipation. */
  radiusPx: number
  /** Run progress 0..1. */
  progress: number
  /** 0..1 fade: rises at touchdown, falls when the storm dissipates. Multiply alpha by it. */
  intensity: number
  elapsed: number
  seed: number
  /** Projected full path, for renderers that want it (squall lines, streaks). */
  path: Pt[]
}

export interface KindRenderer {
  track(f: Frame, a: TrackArgs): void
  cell(f: Frame, a: CellArgs): void
}

/** A campus-wide condition: drawn over the whole view, never over the markers. */
export interface CampusArgs {
  hazard: 'heat' | 'cold' | 'wind'
  /** 0..1 through the arrival animation; stays 1 once it has settled. */
  progress: number
  /** 0..1. Strong while arriving, a faint lingering level after. Multiply alpha by it. */
  intensity: number
  /** ms since it arrived. */
  elapsed: number
  seed: number
}

export interface CampusRenderer {
  draw(f: Frame, a: CampusArgs): void
}
