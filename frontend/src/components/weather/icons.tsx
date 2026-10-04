/** Line icons for the scenario dock. 24px grid, currentColor strokes. */
import type { ReactNode } from 'react'
import type { HazardKind, ScenarioEvent, StormKind } from '../../lib/weather/types'

const GLYPHS: Record<StormKind, ReactNode> = {
  tornado: (
    <>
      <path d="M3 4.5h18" />
      <path d="M5.5 8.5h13" />
      <path d="M9 12.5h10" />
      <path d="M8 16.5h6.5" />
      <path d="M10 20.5h2.5" />
    </>
  ),
  thunderstorm: (
    <>
      <path d="M7.5 16.5h-1a3.5 3.5 0 0 1-.38-6.98 5.25 5.25 0 0 1 10.13-1.27A4.2 4.2 0 0 1 17.5 16.5h-.5" />
      <path d="m13.25 11.5-2.75 4.5h3.5l-2.75 4.5" />
    </>
  ),
  ice: (
    <>
      <path d="M10 3.8v12.4M15.37 6.9 4.63 13.1M15.37 13.1 4.63 6.9" />
      <path d="m8.57 4.62 1.43 1.54 1.43-1.54M13.94 6.07l-.61 2.01 2.05.47M15.38 11.45l-2.05.47.61 2.01M11.43 15.38 10 13.84l-1.43 1.54M6.06 13.93l.61-2.01-2.05-.47M4.62 8.55l2.05-.47-.61-2.01" />
      <path d="M18.5 14.5c1.3 1.55 2 2.7 2 3.6a2 2 0 0 1-4 0c0-.9.7-2.05 2-3.6Z" />
    </>
  ),
  flood: (
    <>
      <path d="M12 10V3M9 6l3-3 3 3" />
      <path d="M3 14.5c1.5 0 1.5-1.75 3-1.75s1.5 1.75 3 1.75 1.5-1.75 3-1.75 1.5 1.75 3 1.75 1.5-1.75 3-1.75 1.5 1.75 3 1.75" />
      <path d="M3 20c1.5 0 1.5-1.75 3-1.75s1.5 1.75 3 1.75 1.5-1.75 3-1.75 1.5 1.75 3 1.75 1.5-1.75 3-1.75 1.5 1.75 3 1.75" />
    </>
  ),
  blizzard: (
    <>
      <path d="M3 8.5h10.5a2.5 2.5 0 1 0-2.5-2.5" />
      <path d="M3 12.5h15a2.5 2.5 0 1 1-2.5 2.5" />
      <path d="M5 17h.01M9 19h.01M5.5 21h.01M11.5 21.5h.01" />
    </>
  ),
  lightning: <path d="M13.5 2.5 5.5 13.5h6l-1 8 8-11h-6l1-8Z" />,
  blackout: (
    <>
      <path d="M9.5 18h5M10.5 21h3" />
      <path d="M9 15c0-1.3-.55-2.2-1.5-3.2a5.5 5.5 0 1 1 9 0c-.95 1-1.5 1.9-1.5 3.2" />
      <path d="m4 3.5 16 17" />
    </>
  ),
  closure: (
    <>
      <rect x="3" y="7" width="18" height="6" rx="1" />
      <path d="m8 7-3 6M13.5 7l-3 6M19 7l-3 6" />
      <path d="M6.5 13v7.5M17.5 13v7.5M4.5 20.5h4M15.5 20.5h4" />
    </>
  ),
}

/** A thermometer on the left half, shared by heat and cold. */
const THERMOMETER = (
  <>
    <path d="M7 14.1V5a2.25 2.25 0 0 1 4.5 0v9.1a4 4 0 1 1-4.5 0Z" />
    <path d="M9.25 10v7" />
  </>
)

const HAZARD_GLYPHS: Record<HazardKind, ReactNode> = {
  heat: (
    <>
      {THERMOMETER}
      <path d="M16 3.5c-1.1 1.4-1.1 2.8 0 4.2s1.1 2.8 0 4.2" />
      <path d="M19.75 3.5c-1.1 1.4-1.1 2.8 0 4.2s1.1 2.8 0 4.2" />
    </>
  ),
  cold: (
    <>
      {THERMOMETER}
      <path d="M17.75 3v7.5M14.5 4.9l6.5 3.75M21 4.9l-6.5 3.75" />
    </>
  ),
  wind: (
    <>
      <path d="M10 4.6A2.2 2.2 0 1 1 11.5 8.5H3" />
      <path d="M17.2 7.6a2.7 2.7 0 1 1 2.05 4.4H3" />
      <path d="M13 19.4a2.2 2.2 0 1 0 1.5-3.9H3" />
    </>
  ),
}

/** A plug pulled out, with a cross beside it. */
const FAULT_GLYPH = (
  <>
    <path d="M7.5 3v3.5M12.5 3v3.5" />
    <path d="M5 6.5h10V10a5 5 0 0 1-10 0V6.5Z" />
    <path d="M10 15v2.5a3 3 0 0 0 3 3h1" />
    <path d="m17 13.5 4 4m0-4-4 4" />
  </>
)

/** Small controls used inside the dock. */
export type UiGlyph = 'play' | 'stop' | 'plus' | 'minus' | 'close' | 'chevron' | 'clock' | 'link' | 'layers' | 'replay' | 'check' | 'alert'

const UI_GLYPHS: Record<UiGlyph, ReactNode> = {
  play: <path d="M7.5 5.2v13.6a.8.8 0 0 0 1.2.7l11-6.8a.8.8 0 0 0 0-1.4l-11-6.8a.8.8 0 0 0-1.2.7Z" fill="currentColor" stroke="none" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  minus: <path d="M5.5 12h13" />,
  close: <path d="m6.5 6.5 11 11m0-11-11 11" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3.5 9 4.75-9 4.75-9-4.75 9-4.75Z" />
      <path d="m3 12.5 9 4.75 9-4.75" />
      <path d="m3 16.5 9 4.75 9-4.75" />
    </>
  ),
  replay: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" />
      <path d="M4.5 4.5V9H9" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: (
    <>
      <path d="M10.3 4.9a2 2 0 0 1 3.4 0l7.1 12.3a2 2 0 0 1-1.7 3H4.9a2 2 0 0 1-1.7-3l7.1-12.3Z" />
      <path d="M12 9.5v4M12 16.8h.01" />
    </>
  ),
}

interface IconProps {
  size?: number
  className?: string
}

function Svg({ size = 20, className, stroke = 1.6, children }: IconProps & { stroke?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function StormIcon({ kind, ...rest }: IconProps & { kind: StormKind }) {
  return <Svg {...rest}>{GLYPHS[kind]}</Svg>
}

export function HazardIcon({ hazard, ...rest }: IconProps & { hazard: HazardKind }) {
  return <Svg {...rest}>{HAZARD_GLYPHS[hazard]}</Svg>
}

export function FaultIcon(props: IconProps) {
  return <Svg {...props}>{FAULT_GLYPH}</Svg>
}

/** The icon for any event in the plan. */
export function EventIcon({ event, ...rest }: IconProps & { event: ScenarioEvent }) {
  if (event.type === 'storm') return <StormIcon kind={event.kind} {...rest} />
  if (event.type === 'hazard') return <HazardIcon hazard={event.hazard} {...rest} />
  return <FaultIcon {...rest} />
}

export function UiIcon({ name, stroke = 2, ...rest }: IconProps & { name: UiGlyph; stroke?: number }) {
  return (
    <Svg stroke={stroke} {...rest}>
      {UI_GLYPHS[name]}
    </Svg>
  )
}
