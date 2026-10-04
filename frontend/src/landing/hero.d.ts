export interface HeroMetrics {
  supply: number
  demand: number
  served: number
  unserved: number
  ok: number
  reduced: number
  dark: number
  moved: number
  essential: number
}

export interface HeroOptions {
  onCaption?: (text: string) => void
  onTick?: (metrics: HeroMetrics, tick: number, total: number) => void
  onPause?: (paused: boolean) => void
  /** Click a building to fail it. */
  interactive?: boolean
  autoplay?: boolean
  /** preserveAspectRatio for the hero SVG. */
  par?: string
}

export interface Hero {
  total: number
  tick: () => number
  setTick: (tick: number, instant?: boolean) => void
  pause: () => void
  play: () => void
  reset: () => void
  fail: (id: string) => void
}

export interface HeroPolicy {
  id: string
  name: string
  desc: string
}

export function mount(svg: SVGSVGElement, opts?: HeroOptions): Hero
export function drawStep(svg: SVGSVGElement, step: number): void
export function drawPolicy(svg: SVGSVGElement, index: number): void
export const POLICIES: HeroPolicy[]
