/**
 * Scenario composer over the map, kept to one slim bar. Pick weather to draw,
 * a campus-wide condition, a grid fault or a tool; the plan sits beside them as
 * numbered chips. Nothing happens until Run, then the whole plan plays on one
 * clock and the bar shrinks to a progress strip with the hits as they land.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject, type SyntheticEvent, type WheelEvent } from 'react'
import { runDuration, travel } from '../../lib/weather/geo'
import { stormLabel } from '../../lib/weather/impacts'
import {
  FAULT_SPECS,
  HAZARD_SPECS,
  RUN_SPEEDS,
  STORM_KINDS,
  STORM_SPECS,
  TICK_MINUTES,
  simClock,
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

type Props = WeatherDockProps

const SHELL = 'border border-line bg-panel/95 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.5)] backdrop-blur-md'
const MENU = 'border border-line bg-panel shadow-[0_14px_36px_-10px_rgba(0,0,0,0.45)]'
const WEATHER = STORM_KINDS.filter((kind) => STORM_SPECS[kind].group === 'weather')
const TOOLS = STORM_KINDS.filter((kind) => STORM_SPECS[kind].group === 'tool')
const HAZARDS = Object.keys(HAZARD_SPECS) as HazardKind[]
const FAULTS = Object.keys(FAULT_SPECS) as FaultKind[]
const DEFAULT_START = '14:00'

/** Height of the line that sits on top of the bar when a kind is armed or a run finished. */
const LINE_PX = 29
/** Popups clear the whole dock: anchors sit about 13px below the top of the 50px row, then a gap. */
const ABOVE = 'calc(100% + var(--lift, 0px) + var(--wrap, 0px) + 21px)'

/** On a narrow map, a 1280 laptop included, the plan strip moves onto a slim line of its own above the toolbar. */
const NARROW_LINE = '@max-[900px]:order-first @max-[900px]:h-[32px] @max-[900px]:basis-full @max-[900px]:border-b @max-[900px]:border-line @max-[900px]:px-1'
const NARROW_HIDE = '@max-[900px]:hidden'
const NARROW_ROW = '@max-[900px]:h-[44px]'
const POPOVER_PX = 300

/** How long a condition or a fault takes to land, at 1x. Used when an event stops starting with the one before it. */
const HAZARD_SECONDS = 3
const FAULT_SECONDS = 2

/** Start times to pick from. They set the clock the plan reads in, not who is on campus. */
const CLOCK_PRESETS: { at: string; note: string }[] = [
  { at: '08:00', note: 'Morning' },
  { at: '10:00', note: 'Late morning' },
  { at: '12:00', note: 'Noon' },
  { at: '14:00', note: 'Afternoon' },
  { at: '17:00', note: 'Early evening' },
  { at: '20:00', note: 'Evening' },
  { at: '23:00', note: 'Late night' },
  { at: '03:00', note: 'Small hours' },
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
const FAULT_CSS = 'light-dark(#a16207, #fcd34d)'

/** The kind's accent for whichever theme is showing, as a CSS colour. */
function accent(kind: StormKind): string {
  return `light-dark(${ON_LIGHT[kind]}, ${STORM_SPECS[kind].accent})`
}

function hazardAccent(hazard: HazardKind): string {
  return `light-dark(${HAZARD_ON_LIGHT[hazard]}, ${HAZARD_SPECS[hazard].accent})`
}

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
  if (event.type === 'fault') return 'grid fault'
  if (event.kind === 'lightning') return 'one strike'
  const { km, heading } = travel(event.path)
  if (km === 0) return 'in place'
  return heading ? `${km.toFixed(1)} km ${heading}` : `${km.toFixed(1)} km, back to its start`
}

/** Seconds the event takes at 1x. */
function eventSeconds(event: ScenarioEvent): number {
  if (event.type === 'storm') return runDuration(event.kind, event.path, STORM_SPECS[event.kind].msPerKm) / 1000
  return event.type === 'hazard' ? HAZARD_SECONDS : FAULT_SECONDS
}

const stop = (event: SyntheticEvent) => event.stopPropagation()

/** Presses and scrolls on the dock never reach the map. */
const GUARD = { onPointerDown: stop, onMouseDown: stop, onDoubleClick: stop, onWheel: stop, onContextMenu: stop }

const mix = (pct: number) => `color-mix(in srgb, var(--accent) ${pct}%, transparent)`

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function meters(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`
}

function speedLabel(speed: number): string {
  return `${speed}×`
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

/** Close a popup on Escape or a press anywhere outside it, except where `keep` says. */
function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void, keep?: (target: Element) => boolean) {
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target || ref.current?.contains(target) || keep?.(target)) return
      close()
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Handled here, so the map's own Escape (disarm, deselect) stays out of it.
      event.preventDefault()
      close()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, ref, close, keep])
}

/**
 * The bar swaps under the pointer when a run starts or stops, so the second click
 * of a double-click would land on Stop, Hide or Run again. Swallow clicks that
 * come right after the swap, and the rest of a multi-click a little longer.
 */
function useSwapGuard() {
  const [born] = useState(() => performance.now())
  return (event: SyntheticEvent<HTMLElement, MouseEvent>) => {
    const age = performance.now() - born
    if (age > 600 || (age > 250 && event.nativeEvent.detail < 2)) return
    event.preventDefault()
    event.stopPropagation()
  }
}

export function WeatherDock(props: Props) {
  // Bottom centre, kept clear of the map's zoom buttons on the right.
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 right-[48px] z-20 flex justify-center @container">
      {!props.open ? <Pill {...props} /> : props.phase === 'running' ? <MiniBar {...props} /> : <Composer {...props} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collapsed: a pill that says how much is planned.
// ---------------------------------------------------------------------------

function Pill({ events, phase, onOpen }: Props) {
  const running = phase === 'running'
  return (
    <button
      type="button"
      {...GUARD}
      onClick={() => onOpen(true)}
      aria-label={`Open the scenario dock, ${running ? 'running' : plural(events.length, 'planned event')}`}
      className={`${SHELL} group pointer-events-auto flex h-8 items-center gap-1.5 rounded-full pl-2.5 pr-3 text-[12px] font-medium text-text transition hover:border-faint`}
    >
      <UiIcon name="layers" size={14} stroke={1.6} className="text-muted transition group-hover:text-text" />
      Scenario
      <span className="text-faint" aria-hidden="true">
        ·
      </span>
      {running ? (
        <span className="relative flex h-2 w-2" aria-hidden="true">
          <span className="absolute inset-0 animate-ping rounded-full bg-branch opacity-60" />
          <span className="relative h-2 w-2 rounded-full bg-branch" />
        </span>
      ) : (
        <span className={`font-mono text-[11.5px] tabular-nums ${events.length ? 'text-branch' : 'text-faint'}`}>{events.length}</span>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Running: progress, the scenario clock, the latest hit, Stop.
// ---------------------------------------------------------------------------

function MiniBar(p: Props) {
  const startsAt = p.startsAt ?? DEFAULT_START
  const guard = useSwapGuard()
  const now = useNow(p.run !== null)
  const total = p.run ? (p.run.total / 1000) * p.speed : 0
  const elapsed = p.run ? Math.min(total, (Math.max(0, now - p.run.startedAt) / 1000) * p.speed) : 0
  const clock = simClock(startsAt, elapsed)
  return (
    <div
      {...GUARD}
      onClickCapture={guard}
      role="region"
      aria-label="Scenario running"
      className={`${SHELL} @container/bar pointer-events-auto relative flex h-[40px] w-full max-w-[560px] items-center gap-2.5 overflow-hidden rounded-xl pl-3 pr-1.5 text-text`}
    >
      {p.run && <Progress run={p.run} />}
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[12px] tabular-nums" title="Scenario clock" aria-label={`Scenario clock ${clock}`}>
        <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
          <span className="absolute inset-0 animate-ping rounded-full bg-branch opacity-70" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-branch" />
        </span>
        <span className="font-medium text-text">{clock}</span>
        {p.run && <span className="text-faint @max-[36rem]:hidden">→ {simClock(startsAt, total)}</span>}
      </span>
      <Rule />
      <Ticker live={p.live} landed={p.landed} error={p.error} errorDetail={p.errorDetail ?? null} settling={p.settling ?? false} />
      <button
        type="button"
        onClick={p.onStop}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-raised pl-2 pr-2.5 text-[12px] font-semibold text-text transition hover:border-faint"
      >
        <UiIcon name="stop" size={10} className="text-down" />
        Stop
      </button>
      <IconButton label="Hide the scenario dock" onClick={() => p.onOpen(false)}>
        <UiIcon name="chevron" size={14} />
      </IconButton>
    </div>
  )
}

function Progress({ run }: { run: { startedAt: number; total: number } }) {
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bar.current
    if (!el) return
    const anim = el.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: Math.max(1, run.total), fill: 'both' })
    anim.currentTime = Math.max(0, performance.now() - run.startedAt)
    return () => anim.cancel()
  }, [run.startedAt, run.total])
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-line/70" aria-hidden="true">
      <div ref={bar} className="h-full origin-left bg-branch shadow-[0_0_8px_var(--color-branch)]" style={{ transform: 'scaleX(0)' }} />
    </div>
  )
}

function Ticker({ live, landed, error, errorDetail, settling }: { live: LiveStorm[]; landed: Impact[]; error: string | null; errorDetail: string | null; settling: boolean }) {
  // Hidden graph roads are counted, not headlined.
  const latest = landed.filter((impact) => impact.target !== 'road').at(-1)
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-[12px]" aria-live="polite">
      {live.length > 0 && (
        <span className="flex shrink-0 items-center -space-x-1.5">
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
      {error ? (
        <span className="truncate text-down" role="alert" title={errorDetail ?? error}>
          {error}
        </span>
      ) : settling ? (
        <span className="flex min-w-0 items-center gap-1.5 text-muted" role="status" title="The run has played out. Its last hits are still reaching the engine.">
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-line border-t-branch" aria-hidden="true" />
          <span className="truncate">Landing on campus…</span>
        </span>
      ) : latest ? (
        <span key={latest.key} className="rise flex min-w-0 items-center gap-1.5" title={`${latest.label} · ${latest.detail}`}>
          <GlyphMark glyph={glyphOf(latest)} />
          {/* The detail gives way first (and goes on a narrow bar); the name only once it is gone. */}
          <span className="min-w-0 truncate text-text">{latest.label}</span>
          <span className="min-w-0 shrink-[1000] truncate text-muted @max-[30rem]/bar:hidden">{latest.detail}</span>
        </span>
      ) : (
        <span className="truncate text-faint">{live.length ? `${live[0].storm.label} on the way` : 'Waiting for the next event'}</span>
      )}
      <span className="ml-auto shrink-0 pl-1 font-mono text-[11px] tabular-nums text-muted">{plural(landed.length, 'hit')}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Composing: the toolbar, the plan as chips, the clock and Run.
// ---------------------------------------------------------------------------

function Composer(p: Props) {
  const { events, selectedId, kind, phase, onSelect } = p
  const startsAt = p.startsAt ?? DEFAULT_START
  const guard = useSwapGuard()
  const armed = kind !== null && (phase === 'armed' || phase === 'drawing')
  const done = phase === 'done' && p.last !== null
  const line = armed ? 'armed' : p.blocked ? 'blocked' : done ? 'done' : p.error ? 'error' : null

  const shell = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLOListElement>(null)
  const card = useRef<HTMLDivElement>(null)

  // Which event's popover is open. A chip click or a pick on the map opens it; an event
  // that was just added or drawn is only highlighted, so drawing the next one stays clear.
  const [pop, setPop] = useState<string | null>(null)
  const [seen, setSeen] = useState({ selectedId, events })
  if (seen.selectedId !== selectedId || seen.events !== events) {
    if (seen.selectedId !== selectedId) {
      const known = selectedId !== null && seen.events.some((e) => e.id === selectedId)
      setPop(known && !armed ? selectedId : null)
    }
    setSeen({ selectedId, events })
  }
  const popIndex = pop !== null && pop === selectedId && !armed ? events.findIndex((e) => e.id === pop) : -1
  const popEvent = popIndex >= 0 ? events[popIndex] : null

  const chipOf = (id: string) => strip.current?.querySelector<HTMLElement>(`[data-chip="${CSS.escape(id)}"]`) ?? null

  // Removed from the keyboard or the popover: focus moves to the next chip, else the one before, else Run, else the first tool.
  const removeEvent = (id: string) => {
    const chips = [...(strip.current?.querySelectorAll<HTMLElement>('[data-chip]') ?? [])]
    const at = chips.findIndex((chip) => chip.dataset.chip === id)
    const next = chips[at + 1] ?? chips[at - 1] ?? null
    const hadFocus = shell.current?.contains(document.activeElement) ?? false
    p.onRemove(id)
    if (!hadFocus) return
    requestAnimationFrame(() => {
      const target = next?.isConnected ? next : shell.current?.querySelector<HTMLElement>('[data-run]:not(:disabled), [role="group"][aria-label="Draw weather"] button')
      target?.focus()
    })
  }

  const closePop = () => {
    const back = popEvent && card.current?.contains(document.activeElement) ? chipOf(popEvent.id) : null
    setPop(null)
    onSelect(null)
    back?.focus()
  }
  useDismiss(popEvent !== null, card, closePop, keepOpen)

  // Opened from the keyboard: focus moves into the popover, and Escape brings it back.
  const keyed = useRef(false)
  const pick = (id: string, fromKeyboard: boolean) => {
    if (pop === id && selectedId === id) {
      setPop(null)
      onSelect(null)
      return
    }
    if (kind) p.onKind(null)
    keyed.current = fromKeyboard
    setPop(id)
    onSelect(id)
  }

  // Keep the selected chip in view, e.g. after a pick on the map or a new event.
  useEffect(() => {
    const el = strip.current
    if (!el || !selectedId) return
    const chip = el.querySelector<HTMLElement>(`[data-chip="${CSS.escape(selectedId)}"]`)
    if (!chip) return
    const left = chip.offsetLeft - 8
    const right = chip.offsetLeft + chip.offsetWidth + 8
    if (left < el.scrollLeft) el.scrollTo({ left, behavior: 'smooth' })
    else if (right > el.scrollLeft + el.clientWidth) el.scrollTo({ left: right - el.clientWidth, behavior: 'smooth' })
  }, [selectedId, events.length])

  // Fade whichever end of the strip has more chips past it.
  const [fade, setFade] = useState({ left: false, right: false })
  useLayoutEffect(() => {
    const el = strip.current
    if (!el) return
    const update = () => {
      const left = el.scrollLeft > 2
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
      setFade((f) => (f.left === left && f.right === right ? f : { left, right }))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [events.length])

  // Where the popover sits: above the dock, centred on its chip, kept inside the dock.
  const [place, setPlace] = useState<{ left: number; caret: number; width: number } | null>(null)
  const popId = popEvent?.id ?? null
  useLayoutEffect(() => {
    if (!popId) return
    const measure = () => {
      const box = shell.current?.getBoundingClientRect()
      const chip = chipOf(popId)?.getBoundingClientRect()
      if (!box || !chip) return
      const width = Math.min(POPOVER_PX, box.width)
      const mid = chip.left + chip.width / 2 - box.left
      const left = Math.max(0, Math.min(box.width - width, mid - width / 2))
      const caret = Math.max(14, Math.min(width - 14, mid - left))
      setPlace((now) => (now && now.left === left && now.caret === caret && now.width === width ? now : { left, caret, width }))
    }
    measure()
    const el = strip.current
    el?.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      el?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [popId, events])

  useEffect(() => {
    if (!keyed.current || !popEvent) return
    const target = card.current?.querySelector<HTMLElement>('[data-body] button:not(:disabled)')
    if (!target) return
    keyed.current = false
    target.focus()
  }, [popEvent, place])

  const onWheel = (e: WheelEvent<HTMLOListElement>) => {
    const el = strip.current
    if (!el || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    el.scrollLeft += e.deltaY
  }

  const mask = fade.left || fade.right ? `linear-gradient(to right, ${fade.left ? 'transparent, #000 20px' : '#000'}, ${fade.right ? '#000 calc(100% - 20px), transparent' : '#000'})` : undefined

  return (
    <div
      ref={shell}
      {...GUARD}
      onClickCapture={guard}
      role="region"
      aria-label="Scenario"
      className={`${SHELL} pointer-events-auto relative w-full max-w-[960px] rounded-xl text-text @max-[900px]:[--wrap:30px]`}
      style={{ '--lift': line ? `${LINE_PX}px` : '0px' } as CSSProperties}
    >
      {line === 'armed' && kind && <ArmedLine {...p} kind={kind} />}
      {line === 'blocked' && p.blocked && (
        <p role="status" className="flex h-[28px] items-center gap-2 border-b border-line px-3 text-[11.5px] text-muted">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true" />
          <span className="truncate">{p.blocked}</span>
        </p>
      )}
      {line === 'done' && p.last && <DoneLine last={p.last} stale={p.stale} error={p.error} errorDetail={p.errorDetail ?? null} onClear={p.onClear} />}
      {line === 'error' && p.error && (
        <p role="alert" className="flex h-[28px] items-center gap-2 border-b border-line px-3 text-[11.5px] text-down" title={p.errorDetail ?? p.error}>
          <UiIcon name="alert" size={13} stroke={1.9} className="shrink-0" />
          <span className="truncate">{p.error}</span>
        </p>
      )}

      <div className="flex flex-wrap items-center">
        <div className={`flex h-[50px] shrink-0 items-center pl-2 ${NARROW_ROW}`}>
          <Tools {...p} />
          <Rule className={NARROW_HIDE} />
        </div>
        <div className={`flex h-[50px] min-w-0 flex-1 items-center ${NARROW_LINE}`}>
          {events.length === 0 ? (
            <p className={`truncate px-2 text-[12px] ${armed ? 'text-faint' : 'text-muted'}`}>{armed ? 'Your plan shows up here' : 'Pick weather, then draw it on the map'}</p>
          ) : (
            <ol
              ref={strip}
              aria-label="Scenario plan"
              onWheel={onWheel}
              className="relative flex h-full min-w-0 flex-1 items-center overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
            >
              {events.map((event, i) => {
                const withPrev = i > 0 && Math.abs(events[i - 1].start - event.start) < 1e-6
                return (
                  <li key={event.id} className="flex shrink-0 items-center">
                    {i > 0 &&
                      (withPrev ? (
                        <span className="h-px w-2 bg-faint/70" title="Starts with the one before" aria-hidden="true" />
                      ) : (
                        <span className="w-1" aria-hidden="true" />
                      ))}
                    <Chip
                      event={event}
                      index={i}
                      startsAt={startsAt}
                      withPrev={withPrev}
                      selected={event.id === selectedId}
                      open={event.id === popEvent?.id}
                      onPick={(fromKeyboard) => pick(event.id, fromKeyboard)}
                      onRemove={() => removeEvent(event.id)}
                    />
                  </li>
                )
              })}
              {!done && (
                <li className="flex shrink-0 items-center pl-1.5">
                  <button
                    type="button"
                    onClick={p.onClear}
                    title="Empty the plan. The campus stays as it is."
                    className="h-7 rounded-md px-1.5 text-[11.5px] text-faint transition hover:bg-raised hover:text-text"
                  >
                    Clear
                  </button>
                </li>
              )}
            </ol>
          )}
        </div>
        <div className={`ml-auto flex h-[50px] shrink-0 items-center gap-1 pr-1.5 ${NARROW_ROW}`}>
          <Rule className={NARROW_HIDE} />
          {p.degraded && <Degraded />}
          <ClockChip startsAt={startsAt} onStartsAt={p.onStartsAt} />
          <SpeedToggle speed={p.speed} onSpeed={p.onSpeed} />
          <RunButton count={events.length} done={done} stale={p.stale} onRun={p.onRun} />
          <IconButton label="Hide the scenario dock" onClick={() => p.onOpen(false)}>
            <UiIcon name="chevron" size={14} />
          </IconButton>
        </div>
      </div>

      {popEvent && place && (
        <EventCard
          ref={card}
          event={popEvent}
          index={popIndex}
          prev={popIndex > 0 ? events[popIndex - 1] : null}
          startsAt={startsAt}
          place={place}
          onUpdate={p.onUpdate}
          onRemove={removeEvent}
          onClose={closePop}
        />
      )}
    </div>
  )
}

/** Presses that leave a chip's popover to someone else: other chips switch it, the map picks or clears. */
function keepOpen(target: Element): boolean {
  return Boolean(target.closest('[data-chip]') || target.closest('.maplibregl-canvas-container'))
}

function Rule({ className = '' }: { className?: string }) {
  return <span className={`mx-1 h-5 w-px shrink-0 bg-line ${className}`} aria-hidden="true" />
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-raised hover:text-text"
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// The toolbar: draw, campus-wide, faults, tools.
// ---------------------------------------------------------------------------

/** A second click on a tool this soon after arming it is the rest of a double-click, not a request to put it down. */
const REARM_MS = 700
const clickTime = () => performance.now()

function Tools({ kind, selectedId, onKind, onSelect, onAddHazard, onAddFault, blocked }: Props) {
  const armedAt = useRef<{ kind: StormKind; at: number } | null>(null)
  const arm = (k: StormKind) => {
    if (blocked) return
    const now = clickTime()
    const quick = armedAt.current?.kind === k && now - armedAt.current.at < REARM_MS
    if (selectedId) onSelect(null)
    if (kind === k && quick) return
    armedAt.current = kind === k ? null : { kind: k, at: now }
    onKind(kind === k ? null : k)
  }
  return (
    <div className="flex shrink-0 items-center">
      <div role="group" aria-label="Draw weather" className="flex items-center gap-0.5">
        {WEATHER.map((k, i) => (
          <Tile key={k} group="Draw on the map" label={STORM_SPECS[k].label} blurb={STORM_SPECS[k].blurb} tint={accent(k)} on={kind === k} blocked={blocked} align={i < 2 ? 'start' : 'center'} onClick={() => arm(k)}>
            <StormIcon kind={k} size={17} />
          </Tile>
        ))}
      </div>
      <Rule />
      <div role="group" aria-label="Campus-wide conditions" className="flex items-center gap-0.5">
        {HAZARDS.map((h) => (
          <Tile key={h} group="Campus-wide · adds to the plan" label={HAZARD_SPECS[h].label} blurb={HAZARD_SPECS[h].blurb} tint={hazardAccent(h)} adds onClick={() => onAddHazard(h)}>
            <HazardIcon hazard={h} size={17} />
          </Tile>
        ))}
      </div>
      <Rule />
      <FaultMenu onAdd={onAddFault} />
      <Rule />
      <div role="group" aria-label="Tools" className="flex items-center gap-0.5">
        {TOOLS.map((k) => (
          <Tile key={k} group="Tool · draw on the map" label={STORM_SPECS[k].label} blurb={STORM_SPECS[k].blurb} tint={accent(k)} on={kind === k} blocked={blocked} onClick={() => arm(k)}>
            <StormIcon kind={k} size={17} />
          </Tile>
        ))}
      </div>
    </div>
  )
}

function Tip({ group, label, blurb, note, align = 'center' }: { group: string; label: string; blurb?: string; note?: string | null; align?: 'start' | 'center' }) {
  return (
    <span
      role="tooltip"
      className={`${MENU} pointer-events-none invisible absolute z-30 w-max max-w-[232px] rounded-lg px-2.5 py-1.5 text-left opacity-0 transition-opacity duration-150 group-hover/tip:visible group-hover/tip:opacity-100 group-hover/tip:delay-300 group-has-[:focus-visible]/tip:visible group-has-[:focus-visible]/tip:opacity-100 ${
        align === 'start' ? 'left-0' : 'left-1/2 -translate-x-1/2'
      }`}
      style={{ bottom: ABOVE }}
    >
      <span className="block text-[9.5px] font-medium uppercase tracking-[0.09em] text-faint">{group}</span>
      <span className="block text-[12px] font-medium text-text">{label}</span>
      {note ? (
        <span className="mt-0.5 block text-[11px] leading-snug text-warn">{note}</span>
      ) : (
        blurb && <span className="mt-0.5 block text-[11px] leading-snug text-muted">{blurb}</span>
      )}
    </span>
  )
}

function Tile(props: {
  group: string
  label: string
  blurb: string
  tint: string
  on?: boolean
  adds?: boolean
  /** Why it cannot be used right now. It stays focusable so the tooltip can say why. */
  blocked?: string | null
  align?: 'start' | 'center'
  onClick: () => void
  children: ReactNode
}) {
  const { on = false, adds = false, blocked = null } = props
  const style = {
    '--accent': props.tint,
    ...(on ? { background: mix(16), color: 'var(--accent)', boxShadow: `inset 0 0 0 1px ${mix(60)}` } : {}),
  } as CSSProperties
  return (
    <span className="group/tip relative flex">
      <button
        type="button"
        aria-pressed={adds ? undefined : on}
        aria-disabled={blocked ? true : undefined}
        aria-label={adds ? `Add ${props.label.toLowerCase()}` : `Draw ${props.label.toLowerCase()}`}
        onClick={(e) => {
          // A mouse click lets go of focus, so a later Escape does not turn it into keyboard focus and pop the tooltip.
          if (e.detail > 0) e.currentTarget.blur()
          props.onClick()
        }}
        style={style}
        className={`group/tile relative grid h-7 w-7 shrink-0 place-items-center rounded-md transition ${
          blocked ? 'cursor-not-allowed text-faint opacity-50' : on ? '' : 'text-muted hover:bg-raised hover:text-[var(--accent)]'
        }`}
      >
        {props.children}
        {adds && (
          <span className="absolute -right-px -top-px grid h-3 w-3 place-items-center rounded-full bg-panel text-[var(--accent)] opacity-0 ring-1 ring-line transition group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100">
            <UiIcon name="plus" size={8} stroke={3} />
          </span>
        )}
      </button>
      <Tip group={props.group} label={props.label} blurb={props.blurb} note={blocked} align={props.align} />
    </span>
  )
}

function FaultMenu({ onAdd }: { onAdd: (fault: FaultKind) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(open, box, () => setOpen(false))
  return (
    <div ref={box} className="group/tip relative flex" style={{ '--accent': FAULT_CSS } as CSSProperties}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add a grid fault"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-7 items-center gap-px rounded-md pl-1 pr-0.5 transition ${
          open ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]' : 'text-muted hover:bg-raised hover:text-[var(--accent)]'
        }`}
      >
        <FaultIcon size={17} />
        <UiIcon name="chevron" size={10} stroke={2.2} className={`transition ${open ? '' : 'rotate-180'}`} />
      </button>
      {!open && <Tip group="Grid faults · adds to the plan" label="Equipment fails" blurb="Power plant, feeds or intakes break with no weather involved." />}
      {open && (
        <div role="menu" aria-label="Grid faults" className={`${MENU} absolute left-0 z-30 w-72 rounded-lg p-1`} style={{ bottom: ABOVE }}>
          <p className="px-2 pb-1 pt-1.5 text-[9.5px] font-medium uppercase tracking-[0.09em] text-faint">Add a grid fault</p>
          {FAULTS.map((f) => (
            <button
              key={f}
              type="button"
              role="menuitem"
              onClick={() => {
                onAdd(f)
                setOpen(false)
              }}
              className="group/item flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-raised focus-visible:bg-raised"
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

// ---------------------------------------------------------------------------
// The line on top: the armed kind and its strength, what a draft would hit,
// or what the last run did.
// ---------------------------------------------------------------------------

function gestureText(kind: StormKind): string {
  if (kind === 'lightning') return 'Click where it strikes'
  if (kind === 'closure') return 'Drag along the streets to close'
  if (STORM_SPECS[kind].input === 'path') return 'Drag across the map to set its path'
  return 'Drag to set its path, or click to drop it'
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

function ArmedLine(p: Props & { kind: StormKind }) {
  const { kind, phase, preview, error } = p
  const spec = STORM_SPECS[kind]
  const step = Math.max(0, Math.min(spec.levels.length - 1, p.level))
  const drawing = phase === 'drawing' && preview !== null
  // A press before the map has loaded would go nowhere, so don't ask for one yet.
  const waiting = p.ready === false
  return (
    <div className="flex h-[28px] items-center gap-2 border-b border-line pl-3 pr-1 text-[11.5px]" style={{ '--accent': accent(kind) } as CSSProperties}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" aria-hidden="true" />
      {drawing && preview ? (
        <Preview kind={kind} level={step} preview={preview} />
      ) : (
        <>
          <span className="shrink-0 font-medium text-text">{spec.label}</span>
          <Segmented label="Strength" options={spec.levels} value={step} onChange={p.onLevel} size="sm" />
          <span className="shrink-0 font-mono text-[10.5px] text-faint @max-[40rem]:hidden" title="Footprint width">
            ~{meters(spec.radius[step] * 2)} wide
          </span>
          {waiting && !error ? (
            <span className="flex min-w-0 items-center gap-1.5 text-faint" role="status">
              <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-line border-t-muted" aria-hidden="true" />
              <span className="truncate">Loading the map…</span>
            </span>
          ) : (
            <span className={`min-w-0 truncate ${error ? 'text-warn' : 'text-muted'}`} role={error ? 'alert' : undefined}>
              {error ?? gestureText(kind)}
            </span>
          )}
        </>
      )}
      <button
        type="button"
        onClick={() => p.onKind(null)}
        aria-label="Stop drawing"
        title="Stop drawing (Esc)"
        className="ml-auto grid h-5 w-5 shrink-0 place-items-center rounded text-faint transition hover:bg-raised hover:text-text"
      >
        <UiIcon name="close" size={11} />
      </button>
    </div>
  )
}

function Preview({ kind, level, preview }: { kind: StormKind; level: number; preview: DockPreview }) {
  const parts = countParts(preview.counts)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 font-medium text-text">{stormLabel(kind, level)}</span>
      <span className="shrink-0 text-muted">
        {preview.lengthKm > 0 ? (
          <>
            <span className="font-mono text-text">{preview.lengthKm.toFixed(1)} km</span> {preview.heading ?? 'back to its start'}
          </>
        ) : (
          'in place'
        )}
      </span>
      <span className="truncate text-muted">· {parts.length === 0 ? 'nothing in its path yet' : `would hit ${parts.join(' · ')}`}</span>
    </span>
  )
}

function DoneLine({
  last,
  stale,
  error,
  errorDetail,
  onClear,
}: {
  last: NonNullable<Props['last']>
  stale: boolean
  error: string | null
  errorDetail: string | null
  onClear: () => void
}) {
  const c = last.counts
  const parts: { text: string; title: string; glyph: Glyph }[] = []
  if (c.buildings) parts.push({ text: `${c.buildings} dark`, title: `${plural(c.buildings, 'building')} went dark`, glyph: 'down' })
  if (c.feeds) parts.push({ text: plural(c.feeds, 'feed'), title: `${plural(c.feeds, 'feed')} running at reduced output`, glyph: 'derate' })
  if (c.lines) parts.push({ text: plural(c.lines, 'line'), title: `${plural(c.lines, 'power line')} down`, glyph: 'spark' })
  if (c.buses) parts.push({ text: `${c.buses} bus`, title: `${plural(c.buses, 'bus line')} closed`, glyph: 'bus' })
  if (c.roads) parts.push({ text: plural(c.roads, 'road'), title: `${plural(c.roads, 'road')} closed`, glyph: 'road' })
  return (
    <div className="flex h-[28px] items-center gap-2 border-b border-line pl-2.5 pr-1 text-[11.5px]">
      {last.failed ? (
        <UiIcon name="alert" size={13} stroke={1.9} className="shrink-0 text-down" />
      ) : last.stopped ? (
        <UiIcon name="stop" size={11} className="shrink-0 text-down" />
      ) : (
        <UiIcon name="check" size={12} stroke={2.4} className="shrink-0 text-muted" />
      )}
      <span className="shrink-0 font-medium text-text">{last.label}</span>
      {last.stopped && (
        <span className="shrink-0 rounded bg-down/12 px-1.5 py-px text-[10.5px] font-medium text-down" title="Stop ended the run part way. What landed before it stays on the campus.">
          Stopped
        </span>
      )}
      <span className="flex min-w-0 items-center gap-2.5 overflow-hidden">
        {parts.length === 0 ? (
          // A failed run says why below instead; a condition says what it did.
          !last.failed && <span className="truncate text-muted">{last.note ?? 'nothing was hit'}</span>
        ) : (
          parts.map((part) => (
            <span key={part.text} title={part.title} className="flex shrink-0 items-center gap-1 tabular-nums text-text">
              <GlyphMark glyph={part.glyph} />
              {part.text}
            </span>
          ))
        )}
      </span>
      {stale && <span className="hidden shrink-0 text-branch @max-[900px]:inline">Plan changed</span>}
      {(error || last.failed) && (
        <span className="min-w-0 truncate text-down" role="alert" title={errorDetail ?? error ?? undefined}>
          {error ?? 'The engine didn’t take part of the plan. Try again.'}
        </span>
      )}
      <button
        type="button"
        onClick={onClear}
        title="Empty the plan. The campus stays as it is; Reset puts it back."
        className="ml-auto h-5 shrink-0 whitespace-nowrap rounded px-1.5 text-[11.5px] text-muted transition hover:bg-raised hover:text-text"
      >
        Clear plan
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The right end: start time, speed, Run.
// ---------------------------------------------------------------------------

function Degraded() {
  return (
    <span className="group/tip relative flex">
      <span tabIndex={0} aria-label="Engine on an older build" className="grid h-7 w-6 place-items-center rounded-md text-warn">
        <UiIcon name="alert" size={15} stroke={1.8} />
      </span>
      <Tip group="Older engine" label="Runs reset the whole campus" blurb="Planned buildings reset too, and bus closures stay on this screen until the engine restarts." />
    </span>
  )
}

/** The scenario's start time on the sim clock. */
function ClockChip({ startsAt, onStartsAt }: { startsAt: string; onStartsAt?: (v: string) => void }) {
  const [menu, setMenu] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(menu, box, () => setMenu(false))
  const face = (
    <>
      <UiIcon name="clock" size={12} stroke={1.8} className="text-faint" />
      <span className="font-mono text-[11.5px] tabular-nums text-text">{startsAt}</span>
    </>
  )
  const chip = 'flex h-7 shrink-0 items-center gap-1 rounded-md border border-line bg-ink/50 px-1.5'
  if (!onStartsAt) {
    return (
      <span className={chip} title="Scenario starts at" aria-label={`Scenario starts at ${startsAt}`}>
        {face}
      </span>
    )
  }
  return (
    <div ref={box} className="relative flex">
      <button
        type="button"
        onClick={() => setMenu((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-label={`Scenario starts at ${startsAt}. Change`}
        title="Scenario starts at"
        className={`${chip} transition hover:border-faint ${menu ? 'border-faint' : ''}`}
      >
        {face}
      </button>
      {menu && (
        <div role="menu" aria-label="Start time" className={`${MENU} absolute right-0 z-30 w-56 rounded-lg p-1`} style={{ bottom: ABOVE }}>
          <p className="px-2 pb-1 pt-1.5 text-[9.5px] font-medium uppercase tracking-[0.09em] text-faint">Starts at</p>
          <p className="px-2 pb-1.5 text-[11px] leading-snug text-muted">Sets the clock the plan reads in. Who is on campus stays the same.</p>
          {CLOCK_PRESETS.map((preset) => {
            const on = preset.at === startsAt
            return (
              <button
                key={preset.at}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                onClick={() => {
                  onStartsAt(preset.at)
                  setMenu(false)
                }}
                className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12px] transition ${on ? 'bg-raised text-text' : 'text-muted hover:bg-raised hover:text-text'}`}
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

function SpeedToggle({ speed, onSpeed }: { speed: number; onSpeed: (speed: number) => void }) {
  const next = RUN_SPEEDS[(RUN_SPEEDS.indexOf(speed as (typeof RUN_SPEEDS)[number]) + 1) % RUN_SPEEDS.length]
  return (
    <button
      type="button"
      onClick={() => onSpeed(next)}
      title="Run speed. Click to change."
      aria-label={`Run speed ${speedLabel(speed)}. Change to ${speedLabel(next)}`}
      className="h-7 w-9 shrink-0 rounded-md text-center font-mono text-[11.5px] text-muted transition hover:bg-raised hover:text-text"
    >
      {speedLabel(speed)}
    </button>
  )
}

function RunButton({ count, done, stale, onRun }: { count: number; done: boolean; stale: boolean; onRun: () => void }) {
  const primary = !done || stale
  return (
    <button
      type="button"
      data-run
      onClick={onRun}
      disabled={count === 0}
      title={count === 0 ? 'Add something to the plan first' : undefined}
      className={`ml-0.5 flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold transition disabled:bg-raised disabled:text-faint disabled:shadow-none ${
        primary
          ? 'bg-branch text-onbranch shadow-[0_6px_16px_-8px_var(--color-branch)] enabled:hover:brightness-110'
          : 'border border-line bg-raised text-text enabled:hover:border-faint'
      }`}
    >
      <UiIcon name={done ? 'replay' : 'play'} size={done ? 13 : 11} stroke={2.2} />
      {!done ? (
        'Run'
      ) : stale ? (
        <>
          <span className="@max-[900px]:hidden">Plan changed · run again</span>
          <span className="hidden @max-[900px]:inline">Run again</span>
        </>
      ) : (
        'Run again'
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Plan chips, and the popover that edits one.
// ---------------------------------------------------------------------------

function Badge({ n, filled }: { n: number; filled: boolean }) {
  return (
    <span
      className={`grid h-4 min-w-4 shrink-0 place-items-center rounded-full px-[3px] font-mono text-[9.5px] font-semibold tabular-nums ${filled ? 'text-panel' : 'text-[var(--accent)]'}`}
      style={filled ? { background: 'var(--accent)' } : { background: mix(14), boxShadow: `inset 0 0 0 1px ${mix(45)}` }}
    >
      {n}
    </span>
  )
}

function Chip(props: {
  event: ScenarioEvent
  index: number
  startsAt: string
  withPrev: boolean
  selected: boolean
  open: boolean
  onPick: (fromKeyboard: boolean) => void
  onRemove: () => void
}) {
  const { event, index, selected } = props
  const at = simClock(props.startsAt, event.start)
  const name = eventLabel(event)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      props.onRemove()
    }
  }
  return (
    <button
      type="button"
      data-chip={event.id}
      onClick={(e) => props.onPick(e.detail === 0)}
      onKeyDown={onKey}
      aria-haspopup="dialog"
      aria-expanded={props.open}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${index + 1}. ${name}, starts ${at}${props.withPrev ? ' with the one before' : ''}`}
      title={`${name} · ${eventNote(event)} · ${at}`}
      className={`flex h-7 items-center gap-1 rounded-md border pl-1 pr-1.5 transition ${selected ? '' : 'border-line/80 bg-ink/40 hover:border-faint/60 hover:bg-raised'}`}
      style={{ '--accent': eventAccent(event), ...(selected ? { borderColor: mix(55), background: mix(13) } : {}) } as CSSProperties}
    >
      <Badge n={index + 1} filled={selected} />
      <span className="flex text-[var(--accent)]">
        <EventIcon event={event} size={14} />
      </span>
      <span className={`font-mono text-[10.5px] tabular-nums ${selected ? 'text-text' : 'text-muted'}`}>{at}</span>
    </button>
  )
}

function compatible(event: Extract<ScenarioEvent, { type: 'storm' }>): StormKind[] {
  const point = event.path.length < 2
  return STORM_KINDS.filter((k) => {
    const input = STORM_SPECS[k].input
    return point ? input !== 'path' : input !== 'point'
  })
}

function EventCard({
  ref,
  event,
  index,
  prev,
  startsAt,
  place,
  onUpdate,
  onRemove,
  onClose,
}: {
  ref: RefObject<HTMLDivElement | null>
  event: ScenarioEvent
  index: number
  prev: ScenarioEvent | null
  startsAt: string
  place: { left: number; caret: number; width: number }
  onUpdate: Props['onUpdate']
  onRemove: Props['onRemove']
  onClose: () => void
}) {
  const withPrev = prev !== null && Math.abs(prev.start - event.start) < 1e-6
  const nudge = (d: number) => onUpdate(event.id, { start: Math.max(0, Math.round((event.start + d) * 2) / 2) })
  const togglePrev = () => {
    if (!prev) return
    onUpdate(event.id, { start: withPrev ? Math.round((prev.start + eventSeconds(prev)) * 2) / 2 : prev.start })
  }
  const name = eventLabel(event)
  const step = TICK_MINUTES / 2
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Edit ${index + 1}. ${name}`}
      className={`${MENU} rise absolute bottom-full z-30 mb-2.5 rounded-xl`}
      style={{ left: place.left, width: place.width, '--accent': eventAccent(event) } as CSSProperties}
    >
      <span
        className="absolute -bottom-[5px] h-2.5 w-2.5 rotate-45 border-b border-r border-line bg-panel"
        style={{ left: place.caret - 5 }}
        aria-hidden="true"
      />
      <div className="flex items-center gap-2 py-1.5 pl-2.5 pr-1">
        <Badge n={index + 1} filled />
        <span className="flex text-[var(--accent)]">
          <EventIcon event={event} size={15} />
        </span>
        <span className="truncate text-[12.5px] font-semibold text-text">{name}</span>
        <span className="truncate text-[11px] text-faint">{eventNote(event)}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint transition hover:bg-raised hover:text-text"
        >
          <UiIcon name="close" size={11} />
        </button>
      </div>
      <div data-body className="space-y-2 border-t border-line px-2.5 py-2.5">
        {event.type === 'storm' ? (
          <>
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
                      className={`grid h-[22px] w-6 place-items-center rounded-[5px] transition ${on ? 'bg-raised' : 'text-faint hover:text-text'}`}
                      style={on ? { color: accent(k), boxShadow: `inset 0 -1.5px 0 ${accent(k)}` } : undefined}
                    >
                      <StormIcon kind={k} size={14} />
                    </button>
                  )
                })}
              </div>
            </Field>
            <Field label="Strength">
              <Segmented
                label="Strength"
                options={STORM_SPECS[event.kind].levels}
                value={Math.min(event.level, STORM_SPECS[event.kind].levels.length - 1)}
                onChange={(level) => onUpdate(event.id, { level })}
              />
            </Field>
          </>
        ) : (
          <p className="text-[11.5px] leading-snug text-muted">
            {event.type === 'hazard' ? HAZARD_SPECS[event.hazard].blurb : `${FAULT_SPECS[event.fault].detail}. ${FAULT_SPECS[event.fault].reason}.`}
          </p>
        )}
        <Field label="Starts">
          <div className="flex items-center rounded-md border border-line bg-ink p-0.5">
            <Step label={`Start ${step} min earlier`} disabled={event.start <= 0} onClick={() => nudge(-0.5)} icon="minus" />
            <span className="min-w-[46px] text-center font-mono text-[11.5px] tabular-nums text-text" aria-live="polite">
              {simClock(startsAt, event.start)}
            </span>
            <Step label={`Start ${step} min later`} onClick={() => nudge(0.5)} icon="plus" />
          </div>
          {prev && (
            <button
              type="button"
              aria-pressed={withPrev}
              onClick={togglePrev}
              title="Start at the same moment as the event before it"
              className={`flex h-[26px] items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition ${
                withPrev ? 'text-text' : 'border-line text-muted hover:text-text'
              }`}
              style={withPrev ? { borderColor: mix(55), background: mix(12) } : undefined}
            >
              <UiIcon name="link" size={12} className={withPrev ? 'text-[var(--accent)]' : ''} />
              With previous
            </button>
          )}
        </Field>
      </div>
      <div className="flex items-center justify-between border-t border-line py-1 pl-2.5 pr-1">
        <span className="text-[11px] text-faint">{event.start > 0 ? `${Math.round(event.start * TICK_MINUTES)} min into the run` : 'Starts the run'}</span>
        <button
          type="button"
          onClick={() => onRemove(event.id)}
          className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted transition hover:bg-down/12 hover:text-down"
        >
          <UiIcon name="close" size={10} />
          Remove
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[50px] shrink-0 text-[10.5px] text-faint">{label}</span>
      {children}
    </div>
  )
}

function Segmented({ label, options, value, onChange, size = 'md' }: { label: string; options: string[]; value: number; onChange: (i: number) => void; size?: 'sm' | 'md' }) {
  const sm = size === 'sm'
  return (
    <div role="group" aria-label={label} className="flex shrink-0 rounded-md border border-line bg-ink p-px">
      {options.map((name, index) => {
        const on = index === value
        return (
          <button
            key={name}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(index)}
            className={`whitespace-nowrap rounded-[5px] font-medium transition ${sm ? 'h-[18px] px-1.5 text-[10.5px]' : 'h-[22px] px-2 text-[11px]'} ${
              on ? 'bg-raised text-text' : 'text-muted hover:text-text'
            }`}
            style={on ? { boxShadow: `inset 0 -1.5px 0 var(--accent)` } : undefined}
          >
            {name}
          </button>
        )
      })}
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
// Small marks for hits: dark, derated, a line down, a closure.
// ---------------------------------------------------------------------------

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
