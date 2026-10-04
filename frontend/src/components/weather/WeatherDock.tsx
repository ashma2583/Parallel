/**
 * Scenario composer over the map. The director stacks up what could hit the
 * campus: weather drawn on the map, campus-wide conditions, and grid faults.
 * Each one can be edited or erased. Nothing happens until Run scenario, then
 * the whole plan plays on one clock and the dock shows the hits as they land.
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject, type SyntheticEvent } from 'react'
import { bearing, compass, pathLength, runDuration } from '../../lib/weather/geo'
import { stormLabel } from '../../lib/weather/impacts'
import {
  FAULT_SPECS,
  HAZARD_SPECS,
  RUN_SPEEDS,
  STORM_KINDS,
  STORM_SPECS,
  type DockPreview,
  type FaultKind,
  type HazardKind,
  type Impact,
  type ImpactCounts,
  type LiveStorm,
  type ScenarioEvent,
  type StormKind,
  type WeatherDockProps,
} from '../../lib/weather/types'
import { EventIcon, FaultIcon, HazardIcon, StormIcon, UiIcon } from './icons'

/** The contract has no clock yet. These ride along until it does. */
type Props = WeatherDockProps & {
  /** Clock time the scenario starts at, "HH:MM". */
  startsAt?: string
  onStartsAt?: (startsAt: string) => void
}

const SHELL = 'border border-line bg-panel/95 shadow-[0_16px_40px_-8px_rgba(0,0,0,0.45)] backdrop-blur-md'
const WEATHER = STORM_KINDS.filter((kind) => STORM_SPECS[kind].group === 'weather')
const TOOLS = STORM_KINDS.filter((kind) => STORM_SPECS[kind].group === 'tool')
const HAZARDS = Object.keys(HAZARD_SPECS) as HazardKind[]
const FAULTS = Object.keys(FAULT_SPECS) as FaultKind[]
const DEFAULT_START = '14:00'

/** How long a condition or a fault takes to land, at 1x. Used when an event stops starting with the one before it. */
const HAZARD_SECONDS = 3
const FAULT_SECONDS = 2

/** Times worth trying: who is on campus changes a lot over a day. */
const CLOCK_PRESETS: { at: string; note: string }[] = [
  { at: '08:00', note: 'First classes' },
  { at: '10:00', note: 'Lectures full' },
  { at: '12:00', note: 'Lunch rush' },
  { at: '14:00', note: 'Afternoon' },
  { at: '17:00', note: 'Commute home' },
  { at: '20:00', note: 'Evening' },
  { at: '23:00', note: 'Dorms full' },
  { at: '03:00', note: 'Overnight' },
]

/** Accents are pale, made for the dark map. These keep the hue but read on the light theme. */
const ON_LIGHT: Record<StormKind, string> = {
  tornado: '#7a6450',
  thunderstorm: '#0d8a80',
  ice: '#0284c7',
  flood: '#2563eb',
  blizzard: '#475569',
  lightning: '#a37f00',
  blackout: '#4f5bd5',
  closure: '#be3455',
}
const HAZARD_ON_LIGHT: Record<HazardKind, string> = { heat: '#c2570c', cold: '#3b6fb6', wind: '#556274' }
const FAULT_ACCENT = { dark: '#fcd34d', light: '#a16207' }

/** The kind's accent for whichever theme is showing, as a CSS colour. */
function accent(kind: StormKind): string {
  return `light-dark(${ON_LIGHT[kind]}, ${STORM_SPECS[kind].accent})`
}

function hazardAccent(hazard: HazardKind): string {
  return `light-dark(${HAZARD_ON_LIGHT[hazard]}, ${HAZARD_SPECS[hazard].accent})`
}

const FAULT_CSS = `light-dark(${FAULT_ACCENT.light}, ${FAULT_ACCENT.dark})`

function eventAccent(event: ScenarioEvent): string {
  if (event.type === 'storm') return accent(event.kind)
  if (event.type === 'hazard') return hazardAccent(event.hazard)
  return FAULT_CSS
}

function eventLabel(event: ScenarioEvent): string {
  if (event.type === 'storm') return stormLabel(event.kind, event.level)
  if (event.type === 'hazard') return HAZARD_SPECS[event.hazard].label
  return FAULT_SPECS[event.fault].label
}

/** "1.4 km north-east", "in place", "campus-wide". */
function eventNote(event: ScenarioEvent): string {
  if (event.type === 'hazard') return 'campus-wide'
  if (event.type === 'fault') return FAULT_SPECS[event.fault].detail
  if (event.path.length < 2) return event.kind === 'lightning' ? 'one strike' : 'in place'
  const km = pathLength(event.path) / 1000
  return `${km.toFixed(1)} km ${compass(bearing(event.path[0], event.path[event.path.length - 1]))}`
}

/** Seconds the event takes at 1x. */
function eventSeconds(event: ScenarioEvent): number {
  if (event.type === 'storm') return runDuration(event.kind, event.path, STORM_SPECS[event.kind].msPerKm) / 1000
  return event.type === 'hazard' ? HAZARD_SECONDS : FAULT_SECONDS
}

const stop = (event: SyntheticEvent) => event.stopPropagation()

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function meters(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`
}

function speedLabel(speed: number): string {
  return speed === 0.5 ? '½×' : `${speed}×`
}

function clockMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (Number.isFinite(h) ? h : 14) * 60 + (Number.isFinite(m) ? m : 0)
}

/** Minutes since midnight to "HH:MM", wrapping past midnight. */
function clockText(minutes: number): string {
  const m = ((Math.floor(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** Seconds after the run starts: "+0:04", "+0:04.5". One second of run is one minute on the scenario clock. */
function offsetText(seconds: number): string {
  const whole = Math.floor(seconds + 1e-6)
  const tenth = Math.round((seconds - whole) * 10)
  return `+${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}${tenth ? `.${tenth}` : ''}`
}

/** Re-render on a timer while something is playing. */
function useNow(active: boolean, every = 250): number {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!active) return
    const tick = () => setNow(performance.now())
    const first = requestAnimationFrame(tick)
    const id = window.setInterval(tick, every)
    return () => {
      cancelAnimationFrame(first)
      window.clearInterval(id)
    }
  }, [active, every])
  return now
}

/** Close a popover on Escape or a press anywhere outside it. */
function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close()
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, ref, close])
}

export function WeatherDock(props: Props) {
  const { open, onOpen, events, phase, run } = props
  const startsAt = props.startsAt ?? DEFAULT_START
  const running = phase === 'running'

  if (!open) {
    return (
      <div className="absolute bottom-6 left-1/2 z-20 -translate-x-1/2" onPointerDown={stop} onMouseDown={stop} onDoubleClick={stop}>
        <button
          type="button"
          onClick={() => onOpen(true)}
          aria-label={`Open the scenario dock, ${plural(events.length, 'planned event')}`}
          className={`${SHELL} group flex items-center gap-2 rounded-full py-2 pl-3 pr-3 text-xs font-medium text-text transition hover:border-faint`}
        >
          <UiIcon name="layers" size={15} stroke={1.6} className="text-muted transition group-hover:text-text" />
          Scenario
          {running ? (
            <span className="relative flex h-2 w-2" aria-label="running">
              <span className="absolute inset-0 animate-ping rounded-full bg-branch opacity-60" />
              <span className="relative h-2 w-2 rounded-full bg-branch" />
            </span>
          ) : (
            <span className={`rounded-full px-1.5 py-px font-mono text-[10px] ${events.length ? 'bg-branch/15 text-branch' : 'bg-raised text-faint'}`}>
              {events.length}
            </span>
          )}
        </button>
      </div>
    )
  }

  return (
    <div
      className={`${SHELL} absolute bottom-6 left-1/2 z-20 w-[min(600px,calc(100%-32px))] -translate-x-1/2 rounded-xl text-xs text-text`}
      onPointerDown={stop}
      onMouseDown={stop}
      onDoubleClick={stop}
      onWheel={stop}
      onContextMenu={stop}
      role="region"
      aria-label="Scenario"
    >
      {run && <ProgressEdge run={run} />}
      <Header {...props} startsAt={startsAt} />
      <AddBar {...props} />
      <PlanList {...props} startsAt={startsAt} />
      <Footer {...props} startsAt={startsAt} />
      {props.degraded && (
        <p className="flex items-start gap-1.5 border-t border-line px-3 py-1.5 text-[10.5px] leading-snug text-faint">
          <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-warn" aria-hidden="true" />
          Engine on an older build: runs reset the whole campus, planned buildings too; bus closures stay on this screen until it restarts.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header: title, clock, speed, collapse.
// ---------------------------------------------------------------------------

function ProgressEdge({ run }: { run: { startedAt: number; total: number } }) {
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bar.current
    if (!el) return
    const anim = el.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: Math.max(1, run.total), fill: 'both' })
    anim.currentTime = Math.max(0, performance.now() - run.startedAt)
    return () => anim.cancel()
  }, [run.startedAt, run.total])
  return (
    <div className="pointer-events-none absolute inset-x-3 -top-px h-[2px] overflow-hidden rounded-full" aria-hidden="true">
      <div ref={bar} className="h-full origin-left rounded-full bg-branch shadow-[0_0_8px_var(--color-branch)]" style={{ transform: 'scaleX(0)' }} />
    </div>
  )
}

function Header(p: Props & { startsAt: string }) {
  const { speed, onSpeed, onOpen, events } = p
  const running = p.phase === 'running'
  return (
    <div className="flex h-10 items-center gap-2 pl-3 pr-1.5">
      <span className="text-[12.5px] font-semibold tracking-[-0.005em] text-text">Scenario</span>
      <ClockChip {...p} />
      <span className="truncate text-[11px] text-faint">
        {running ? 'Running' : events.length ? plural(events.length, 'event') : 'Nothing planned'}
      </span>
      <div className="ml-auto flex items-center">
        <button
          type="button"
          onClick={() => onSpeed(RUN_SPEEDS[(RUN_SPEEDS.indexOf(speed as (typeof RUN_SPEEDS)[number]) + 1) % RUN_SPEEDS.length])}
          title="Run speed. Click to change."
          aria-label={`Run speed ${speedLabel(speed)}`}
          className="h-7 min-w-8 rounded-md px-1.5 font-mono text-[11px] text-muted transition hover:bg-raised hover:text-text"
        >
          {speedLabel(speed)}
        </button>
        <button
          type="button"
          onClick={() => onOpen(false)}
          aria-label="Hide the scenario dock"
          className="grid h-7 w-7 place-items-center rounded-md text-muted transition hover:bg-raised hover:text-text"
        >
          <UiIcon name="chevron" size={14} />
        </button>
      </div>
    </div>
  )
}

/** The scenario's start time, and the scenario clock while it runs. */
function ClockChip(p: Props & { startsAt: string }) {
  const running = p.phase === 'running' && p.run !== null
  const now = useNow(running)
  const [menu, setMenu] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(menu, box, () => setMenu(false))
  const base = clockMinutes(p.startsAt)
  const live = running && p.run ? base + Math.max(0, now - p.run.startedAt) * (p.speed / 1000) : base
  const editable = Boolean(p.onStartsAt) && !running
  const chip = (
    <>
      {running ? (
        <span className="relative mr-0.5 flex h-1.5 w-1.5" aria-hidden="true">
          <span className="absolute inset-0 animate-ping rounded-full bg-branch opacity-70" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-branch" />
        </span>
      ) : (
        <UiIcon name="clock" size={12} stroke={1.8} className="text-faint" />
      )}
      <span className={`font-mono text-[11px] tabular-nums ${running ? 'text-text' : 'text-muted'}`}>{clockText(live)}</span>
    </>
  )
  const chipClass = 'flex h-6 items-center gap-1 rounded-md border border-line bg-ink/60 px-1.5'
  if (!editable) {
    return (
      <span className={chipClass} title={running ? 'Scenario clock' : 'Scenario starts at'} aria-label={`Scenario clock ${clockText(live)}`}>
        {chip}
      </span>
    )
  }
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setMenu((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-label={`Scenario starts at ${p.startsAt}. Change`}
        className={`${chipClass} transition hover:border-faint`}
      >
        {chip}
      </button>
      {menu && (
        <div role="menu" className={`${SHELL} absolute bottom-full left-0 mb-2 w-48 rounded-lg p-1`}>
          <p className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-faint">Starts at</p>
          {CLOCK_PRESETS.map((preset) => {
            const on = preset.at === p.startsAt
            return (
              <button
                key={preset.at}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                onClick={() => {
                  p.onStartsAt?.(preset.at)
                  setMenu(false)
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition ${on ? 'bg-raised text-text' : 'text-muted hover:bg-raised hover:text-text'}`}
              >
                <span className="font-mono tabular-nums">{preset.at}</span>
                <span className="truncate">{preset.note}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add bar: draw a storm, add a condition or a fault, use a tool.
// ---------------------------------------------------------------------------

function AddBar(p: Props) {
  const { kind, onKind, onAddHazard, onAddFault } = p
  const running = p.phase === 'running'
  const arm = (k: StormKind) => onKind(kind === k ? null : k)
  return (
    <div className="border-t border-line">
      <div className="flex flex-wrap items-end gap-x-2.5 gap-y-1.5 px-2.5 pb-2 pt-1.5">
        <Group label="Draw">
          {WEATHER.map((k) => (
            <Tile key={k} label={STORM_SPECS[k].label} title={`${STORM_SPECS[k].label}. ${STORM_SPECS[k].blurb}`} tint={accent(k)} on={kind === k} disabled={running} onClick={() => arm(k)}>
              <StormIcon kind={k} size={17} />
            </Tile>
          ))}
        </Group>
        <Rule />
        <Group label="Campus-wide">
          {HAZARDS.map((h) => (
            <Tile
              key={h}
              label={`Add ${HAZARD_SPECS[h].label.toLowerCase()}`}
              title={`${HAZARD_SPECS[h].label}. ${HAZARD_SPECS[h].blurb}`}
              tint={hazardAccent(h)}
              adds
              disabled={running}
              onClick={() => onAddHazard(h)}
            >
              <HazardIcon hazard={h} size={17} />
            </Tile>
          ))}
        </Group>
        <Rule />
        <Group label="Grid faults">
          <FaultMenu disabled={running} onAdd={onAddFault} />
        </Group>
        <Rule />
        <Group label="Tools">
          {TOOLS.map((k) => (
            <Tile key={k} label={STORM_SPECS[k].label} title={`${STORM_SPECS[k].label}. ${STORM_SPECS[k].blurb}`} tint={accent(k)} on={kind === k} disabled={running} onClick={() => arm(k)}>
              <StormIcon kind={k} size={17} />
            </Tile>
          ))}
        </Group>
      </div>
      {kind && !running && (
        <div className="border-t border-dashed border-line px-3 py-1.5">
          {p.phase === 'drawing' && p.preview ? <Preview kind={kind} level={p.level} preview={p.preview} /> : <Armed kind={kind} level={p.level} onLevel={p.onLevel} />}
        </div>
      )}
    </div>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="shrink-0" role="group" aria-label={label}>
      <p className="mb-1 px-0.5 text-[9.5px] font-medium uppercase tracking-[0.09em] text-faint">{label}</p>
      <div className="flex items-center gap-0.5">{children}</div>
    </div>
  )
}

function Rule() {
  return <span className="mb-1 h-6 w-px shrink-0 bg-line" aria-hidden="true" />
}

function Tile(props: { label: string; title: string; tint: string; on?: boolean; adds?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  const { on = false, adds = false } = props
  const style = {
    '--accent': props.tint,
    ...(on
      ? {
          borderColor: 'color-mix(in srgb, var(--accent) 62%, transparent)',
          background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
          color: 'var(--accent)',
        }
      : {}),
  } as CSSProperties
  return (
    <button
      type="button"
      aria-pressed={adds ? undefined : on}
      aria-label={props.label}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      style={style}
      className={`group/tile relative grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg border transition disabled:opacity-35 ${
        on ? '' : 'border-transparent text-muted enabled:hover:bg-raised enabled:hover:text-[var(--accent)]'
      }`}
    >
      {props.children}
      {adds && (
        <span className="absolute -right-0.5 -top-0.5 grid h-3 w-3 place-items-center rounded-full bg-panel text-[var(--accent)] opacity-0 ring-1 ring-line transition group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100">
          <UiIcon name="plus" size={8} stroke={3} />
        </span>
      )}
    </button>
  )
}

function FaultMenu({ disabled, onAdd }: { disabled: boolean; onAdd: (fault: FaultKind) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(open, box, () => setOpen(false))
  return (
    <div ref={box} className="relative" style={{ '--accent': FAULT_CSS } as CSSProperties}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add a grid fault"
        title="Equipment that fails with no weather involved"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-[30px] items-center gap-0.5 rounded-lg border pl-1.5 pr-1 transition disabled:opacity-35 ${
          open
            ? 'border-[color-mix(in_srgb,var(--accent)_55%,transparent)] bg-[color-mix(in_srgb,var(--accent)_13%,transparent)] text-[var(--accent)]'
            : 'border-transparent text-muted enabled:hover:bg-raised enabled:hover:text-[var(--accent)]'
        }`}
      >
        <FaultIcon size={17} />
        <UiIcon name="chevron" size={11} className={`transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" className={`${SHELL} absolute bottom-full left-1/2 mb-2 w-72 -translate-x-1/2 rounded-lg p-1`}>
          <p className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-faint">Add a grid fault</p>
          {FAULTS.map((f) => (
            <button
              key={f}
              type="button"
              role="menuitem"
              onClick={() => {
                onAdd(f)
                setOpen(false)
              }}
              className="group/item flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-raised"
            >
              <span className="mt-0.5 text-faint transition group-hover/item:text-[var(--accent)]">
                <FaultIcon size={14} />
              </span>
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-text">{FAULT_SPECS[f].label}</span>
                <span className="block text-[11px] leading-snug text-muted">{FAULT_SPECS[f].detail}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function gestureText(kind: StormKind): string {
  if (kind === 'lightning') return 'Click where it strikes'
  if (kind === 'closure') return 'Drag along the streets to close'
  if (STORM_SPECS[kind].input === 'path') return 'Drag across the map to set its path'
  return 'Drag across the map to set its path · click to drop'
}

function Armed({ kind, level, onLevel }: { kind: StormKind; level: number; onLevel: (level: number) => void }) {
  const spec = STORM_SPECS[kind]
  const step = Math.max(0, Math.min(spec.levels.length - 1, level))
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[12px]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: accent(kind) }} aria-hidden="true" />
          <span className="truncate font-medium text-text">{stormLabel(kind, step)}</span>
          <span className="shrink-0 font-mono text-[10.5px] text-faint" title="Footprint width">
            ~{meters(spec.radius[step] * 2)} wide
          </span>
        </p>
        <p className="truncate pl-3.5 text-[11.5px] text-muted">{gestureText(kind)}</p>
      </div>
      <Segmented label="Strength" options={spec.levels} value={step} tint={accent(kind)} onChange={onLevel} />
    </div>
  )
}

/** "3 buildings · 1 feed · 2 lines · 4 bus lines", zero counts left out. */
function countParts(counts: ImpactCounts): string[] {
  const parts: string[] = []
  if (counts.buildings) parts.push(plural(counts.buildings, 'building'))
  if (counts.feeds) parts.push(plural(counts.feeds, 'feed'))
  if (counts.lines) parts.push(plural(counts.lines, 'line'))
  if (counts.buses) parts.push(plural(counts.buses, 'bus line'))
  if (counts.roads) parts.push(plural(counts.roads, 'road'))
  return parts
}

function Preview({ kind, level, preview }: { kind: StormKind; level: number; preview: DockPreview }) {
  const parts = countParts(preview.counts)
  return (
    <p className="flex min-h-7 items-center gap-2 truncate text-[12px]">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: accent(kind) }} aria-hidden="true" />
      <span className="shrink-0 font-medium text-text">{stormLabel(kind, level)}</span>
      <span className="shrink-0 text-text">
        {preview.heading ? (
          <>
            <span className="font-mono">{preview.lengthKm.toFixed(1)} km</span> {preview.heading}
          </>
        ) : (
          'in place'
        )}
      </span>
      <span className="truncate text-muted">· {parts.length === 0 ? 'nothing in its path yet' : `would hit ${parts.join(' · ')}`}</span>
    </p>
  )
}

function Segmented({ label, options, value, tint, onChange }: { label: string; options: string[]; value: number; tint: string; onChange: (i: number) => void }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 rounded-md border border-line bg-ink p-0.5">
      {options.map((name, index) => {
        const on = index === value
        return (
          <button
            key={name}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(index)}
            className={`whitespace-nowrap rounded-[5px] px-2 py-[3px] text-[11px] font-medium transition ${on ? 'bg-raised text-text' : 'text-muted hover:text-text'}`}
            style={on ? { boxShadow: `inset 0 -1.5px 0 ${tint}` } : undefined}
          >
            {name}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The plan: every event in start order, the selected one opened for editing.
// ---------------------------------------------------------------------------

type RowState = 'pending' | 'live' | 'done'

function PlanList(p: Props & { startsAt: string }) {
  const { events, selectedId, onSelect } = p
  const running = p.phase === 'running' && p.run !== null
  const now = useNow(running)
  const list = useRef<HTMLOListElement>(null)

  // Keep the selected row in view, e.g. after selecting a ghost on the map.
  useEffect(() => {
    if (!selectedId) return
    list.current?.querySelector<HTMLElement>(`[data-event="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  if (events.length === 0) {
    return (
      <div className="flex items-center gap-2.5 border-t border-line px-3 py-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-dashed border-line text-faint">
          <UiIcon name="plus" size={13} />
        </span>
        <p className="text-[12px] leading-snug text-muted">
          Draw weather on the map or add a condition. <span className="text-faint">Nothing happens until you run it.</span>
        </p>
      </div>
    )
  }

  const elapsed = running && p.run ? (Math.max(0, now - p.run.startedAt) / 1000) * p.speed : 0
  const state = (event: ScenarioEvent): RowState | null => {
    if (!running) return null
    if (elapsed < event.start) return 'pending'
    return elapsed < event.start + eventSeconds(event) ? 'live' : 'done'
  }

  return (
    <ol ref={list} className="max-h-[208px] overflow-y-auto border-t border-line px-1.5 py-1.5 [scrollbar-width:thin]" aria-label="Scenario plan">
      {events.map((event, i) => (
        <PlanRow
          key={event.id}
          event={event}
          index={i}
          prev={i > 0 ? events[i - 1] : null}
          selected={event.id === selectedId}
          state={state(event)}
          editable={!running}
          startsAt={p.startsAt}
          onSelect={() => onSelect(event.id === selectedId ? null : event.id)}
          onUpdate={p.onUpdate}
          onRemove={p.onRemove}
        />
      ))}
    </ol>
  )
}

function PlanRow(props: {
  event: ScenarioEvent
  index: number
  prev: ScenarioEvent | null
  selected: boolean
  state: RowState | null
  editable: boolean
  startsAt: string
  onSelect: () => void
  onUpdate: Props['onUpdate']
  onRemove: Props['onRemove']
}) {
  const { event, index, prev, selected, state, editable } = props
  const tint = eventAccent(event)
  const withPrev = prev !== null && Math.abs(prev.start - event.start) < 1e-6
  const open = selected && editable
  const at = clockText(clockMinutes(props.startsAt) + event.start)

  const onKey = (e: KeyboardEvent) => {
    if (!editable) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      props.onRemove(event.id)
    }
  }

  return (
    <li
      data-event={event.id}
      className={`group/row rounded-lg transition ${open ? 'my-0.5 bg-raised/70 ring-1 ring-line' : selected ? 'bg-raised/60' : 'hover:bg-raised/45'} ${
        state === 'done' ? 'opacity-55' : ''
      }`}
      style={{ '--accent': tint } as CSSProperties}
    >
      <div className="flex items-center">
        <button
          type="button"
          onClick={props.onSelect}
          onKeyDown={onKey}
          aria-expanded={editable ? open : undefined}
          aria-current={selected ? 'true' : undefined}
          aria-label={`${index + 1}. ${eventLabel(event)}, ${withPrev ? `with event ${index}` : `starts ${offsetText(event.start)}`}`}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg pl-1.5 pr-2 text-left"
        >
          <Badge n={index + 1} state={state} selected={selected} />
          <span className="flex shrink-0 text-[var(--accent)]">
            <EventIcon event={event} size={15} />
          </span>
          <span className="shrink-0 text-[12px] font-medium text-text">{eventLabel(event)}</span>
          <span className="min-w-0 truncate text-[11px] text-faint">{eventNote(event)}</span>
          <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] tabular-nums text-muted" title={`Starts at ${at} on the scenario clock`}>
            {state === 'live' ? <span className="text-[var(--accent)]">now</span> : withPrev ? `with #${index}` : offsetText(event.start)}
          </span>
        </button>
        {editable && !open && (
          <button
            type="button"
            onClick={() => props.onRemove(event.id)}
            aria-label={`Remove ${eventLabel(event)}`}
            title="Remove"
            className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint opacity-0 transition hover:bg-down/15 hover:text-down focus-visible:opacity-100 group-hover/row:opacity-100"
          >
            <UiIcon name="close" size={12} />
          </button>
        )}
      </div>
      {open && <RowEditor event={event} prev={prev} withPrev={withPrev} at={at} onUpdate={props.onUpdate} onRemove={props.onRemove} />}
    </li>
  )
}

function Badge({ n, state, selected }: { n: number; state: RowState | null; selected: boolean }) {
  const filled = selected || state === 'live'
  return (
    <span
      className={`relative grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full font-mono text-[10px] font-medium tabular-nums ${
        filled ? 'text-panel' : 'text-[var(--accent)]'
      }`}
      style={
        filled
          ? { background: 'var(--accent)' }
          : { background: 'color-mix(in srgb, var(--accent) 14%, transparent)', boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent)' }
      }
    >
      {state === 'live' && <span className="absolute inset-0 animate-ping rounded-full bg-[var(--accent)] opacity-40" aria-hidden="true" />}
      {state === 'done' ? (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      ) : (
        <span className="relative">{n}</span>
      )}
    </span>
  )
}

function compatible(event: Extract<ScenarioEvent, { type: 'storm' }>): StormKind[] {
  const point = event.path.length < 2
  return STORM_KINDS.filter((k) => {
    const input = STORM_SPECS[k].input
    return point ? input !== 'path' : input !== 'point'
  })
}

function RowEditor({
  event,
  prev,
  withPrev,
  at,
  onUpdate,
  onRemove,
}: {
  event: ScenarioEvent
  prev: ScenarioEvent | null
  withPrev: boolean
  at: string
  onUpdate: Props['onUpdate']
  onRemove: Props['onRemove']
}) {
  const nudge = (d: number) => onUpdate(event.id, { start: Math.max(0, Math.round((event.start + d) * 2) / 2) })
  const togglePrev = () => {
    if (!prev) return
    onUpdate(event.id, { start: withPrev ? Math.round((prev.start + eventSeconds(prev)) * 2) / 2 : prev.start })
  }
  return (
    <div className="space-y-2 px-2.5 pb-2.5 pt-0.5">
      {event.type === 'storm' ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Field label="Strength">
            <Segmented
              label="Strength"
              options={STORM_SPECS[event.kind].levels}
              value={Math.min(event.level, STORM_SPECS[event.kind].levels.length - 1)}
              tint={accent(event.kind)}
              onChange={(level) => onUpdate(event.id, { level })}
            />
          </Field>
          <Field label="Kind">
            <div role="group" aria-label="Kind" className="flex rounded-md border border-line bg-ink p-0.5">
              {compatible(event).map((k) => {
                const on = k === event.kind
                return (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={on}
                    aria-label={STORM_SPECS[k].label}
                    title={STORM_SPECS[k].label}
                    onClick={() => onUpdate(event.id, { kind: k, level: Math.min(event.level, STORM_SPECS[k].levels.length - 1) })}
                    className={`grid h-[22px] w-[24px] place-items-center rounded-[5px] transition ${on ? 'bg-raised' : 'text-faint hover:text-text'}`}
                    style={on ? { color: accent(k), boxShadow: `inset 0 -1.5px 0 ${accent(k)}` } : undefined}
                  >
                    <StormIcon kind={k} size={14} />
                  </button>
                )
              })}
            </div>
          </Field>
        </div>
      ) : (
        <p className="text-[11.5px] leading-snug text-muted">
          {event.type === 'hazard' ? HAZARD_SPECS[event.hazard].blurb : `${FAULT_SPECS[event.fault].detail}. ${FAULT_SPECS[event.fault].reason}.`}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Field label="Starts">
          <div className="flex items-center rounded-md border border-line bg-ink p-0.5">
            <Step label="Start half a second earlier" disabled={event.start <= 0} onClick={() => nudge(-0.5)} icon="minus" />
            <span className="min-w-[52px] text-center font-mono text-[11px] tabular-nums text-text" title={`${at} on the scenario clock`}>
              {offsetText(event.start)}
            </span>
            <Step label="Start half a second later" onClick={() => nudge(0.5)} icon="plus" />
          </div>
        </Field>
        {prev && (
          <button
            type="button"
            aria-pressed={withPrev}
            onClick={togglePrev}
            title="Start at the same moment as the event before it"
            className={`flex h-[26px] items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition ${
              withPrev ? 'border-[color-mix(in_srgb,var(--accent)_55%,transparent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-text' : 'border-line text-muted hover:text-text'
            }`}
          >
            <UiIcon name="link" size={12} className={withPrev ? 'text-[var(--accent)]' : ''} />
            With previous
          </button>
        )}
        <span className="font-mono text-[10.5px] text-faint">{at}</span>
        <button
          type="button"
          onClick={() => onRemove(event.id)}
          className="ml-auto flex h-[26px] items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted transition hover:bg-down/12 hover:text-down"
        >
          <UiIcon name="close" size={11} />
          Remove
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10.5px] text-faint">{label}</span>
      {children}
    </div>
  )
}

function Step({ label, icon, disabled, onClick }: { label: string; icon: 'plus' | 'minus'; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-[22px] w-[22px] place-items-center rounded-[5px] text-muted transition enabled:hover:bg-raised enabled:hover:text-text disabled:opacity-30"
    >
      <UiIcon name={icon} size={11} stroke={2.4} />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Footer: run, stop, and what the last run did.
// ---------------------------------------------------------------------------

function Footer(p: Props & { startsAt: string }) {
  const { events, phase } = p
  const count = events.length
  const end = events.reduce((m, e) => Math.max(m, e.start + eventSeconds(e)), 0)
  const base = clockMinutes(p.startsAt)

  if (phase === 'running') {
    return (
      <div className="flex min-h-11 items-center gap-2.5 border-t border-line px-2 py-1.5">
        <button
          type="button"
          onClick={p.onStop}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-raised px-3 text-[12px] font-semibold text-text transition hover:border-faint"
        >
          <UiIcon name="stop" size={11} className="text-down" />
          Stop
        </button>
        <Ticker live={p.live} landed={p.landed} />
        {p.error && <ErrorText text={p.error} />}
      </div>
    )
  }

  const done = phase === 'done' && p.last
  const runLabel = done ? (p.stale ? 'Plan changed · run again' : 'Run again') : 'Run scenario'
  const primary = !done || p.stale
  return (
    <div className="border-t border-line">
      {done && p.last && <Summary last={p.last} />}
      <div className="flex min-h-11 items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={p.onRun}
          disabled={count === 0}
          className={`flex h-8 shrink-0 items-center gap-2 rounded-lg px-3 text-[12px] font-semibold transition disabled:bg-raised disabled:text-faint ${
            primary
              ? 'bg-branch text-onbranch enabled:shadow-[0_6px_18px_-6px_var(--color-branch)] enabled:hover:brightness-110'
              : 'border border-line bg-raised text-text enabled:hover:border-faint'
          }`}
        >
          <UiIcon name={done ? 'replay' : 'play'} size={done ? 13 : 11} stroke={2.2} />
          {runLabel}
          {count > 0 && (
            <span className={`rounded-full px-1.5 py-px font-mono text-[10px] ${primary ? 'bg-onbranch/20' : 'bg-panel text-muted'}`}>{count}</span>
          )}
        </button>
        {count > 0 && !done && (
          <span className="truncate font-mono text-[10.5px] text-faint" title="Scenario clock, one second of run per minute">
            {clockText(base)} → {clockText(base + Math.ceil(end))}
          </span>
        )}
        {p.error && <ErrorText text={p.error} />}
        {count > 0 && (
          <button
            type="button"
            onClick={p.onClear}
            className="ml-auto h-8 shrink-0 rounded-lg px-2.5 text-[12px] font-medium text-muted transition hover:bg-raised hover:text-text"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  )
}

function ErrorText({ text }: { text: string }) {
  return (
    <span className="min-w-0 truncate text-[11px] text-down" role="alert" title={text}>
      {text}
    </span>
  )
}

function Ticker({ live, landed }: { live: LiveStorm[]; landed: Impact[] }) {
  // Hidden graph roads are counted, not headlined.
  const latest = landed.filter((impact) => impact.target !== 'road').at(-1)
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-[12px]" aria-live="polite">
      {live.length > 0 && (
        <span className="flex shrink-0 items-center -space-x-1">
          {live.slice(0, 3).map((l) => (
            <span
              key={l.storm.id}
              title={l.storm.label}
              className="grid h-6 w-6 place-items-center rounded-full border border-line bg-panel"
              style={{ color: accent(l.storm.kind) }}
            >
              <StormIcon kind={l.storm.kind} size={13} />
            </span>
          ))}
        </span>
      )}
      {latest ? (
        <span key={latest.key} className="rise flex min-w-0 items-center gap-1.5">
          <GlyphMark glyph={glyphOf(latest)} />
          <span className="truncate text-text">{latest.label}</span>
          <span className="truncate text-muted">{latest.detail}</span>
        </span>
      ) : (
        <span className="text-faint">{live.length ? `${live[0].storm.label} on the way` : 'Waiting for the next event'}</span>
      )}
      <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] text-muted">{plural(landed.length, 'hit')}</span>
    </div>
  )
}

function Summary({ last }: { last: { label: string; counts: ImpactCounts } }) {
  const c = last.counts
  const chips: { text: string; glyph: Glyph }[] = []
  if (c.buildings) chips.push({ text: `${plural(c.buildings, 'building')} dark`, glyph: 'down' })
  if (c.feeds) chips.push({ text: `${plural(c.feeds, 'feed')} hit`, glyph: 'down' })
  if (c.lines) chips.push({ text: `${plural(c.lines, 'line')} down`, glyph: 'spark' })
  if (c.buses) chips.push({ text: `${plural(c.buses, 'bus line')} closed`, glyph: 'bus' })
  if (c.roads) chips.push({ text: `${plural(c.roads, 'road')} closed`, glyph: 'road' })
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2">
      <span className="mr-1 text-[12px] font-medium text-text">{last.label}</span>
      {chips.length === 0 ? (
        <span className="rounded-full border border-line bg-raised/60 px-2 py-0.5 text-[11px] text-muted">Nothing was hit</span>
      ) : (
        chips.map((chip) => (
          <span key={chip.text} className="flex items-center gap-1.5 rounded-full border border-line bg-raised/60 py-0.5 pl-1.5 pr-2 text-[11px] text-text">
            <GlyphMark glyph={chip.glyph} />
            {chip.text}
          </span>
        ))
      )}
    </div>
  )
}

type Glyph = 'down' | 'derate' | 'spark' | 'bus' | 'road'

function glyphOf(impact: Impact): Glyph {
  if (impact.target === 'line') return 'spark'
  if (impact.target === 'bus') return 'bus'
  if (impact.target === 'road') return 'road'
  return impact.action === 'derate' ? 'derate' : 'down'
}

const SPARK = 'color-mix(in srgb, #facc15 72%, var(--color-text))'

function GlyphMark({ glyph }: { glyph: Glyph }) {
  if (glyph === 'down' || glyph === 'derate') {
    return (
      <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
        <span className={`h-2 w-2 rounded-full ${glyph === 'down' ? 'bg-down' : 'bg-warn'}`} />
      </span>
    )
  }
  if (glyph === 'spark') {
    return (
      <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M8.2 1.8 4.6 7.2h4.2L5.6 12.4" stroke={SPARK} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    )
  }
  return (
    <span className={`grid h-3.5 w-3.5 shrink-0 place-items-center ${glyph === 'bus' ? 'text-down' : 'text-muted'}`}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="m4 4 6 6m0-6-6 6" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
      </svg>
    </span>
  )
}
