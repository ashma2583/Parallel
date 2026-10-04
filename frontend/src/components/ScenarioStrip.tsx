import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { fetchHazards, resetSim, type Hazard, type HazardList } from '../lib/api'
import { FAULT_SPECS, type FaultSpec, type WeatherRequest } from '../lib/weather/types'
import { FaultIcon, HazardIcon, StormIcon } from './weather/icons'

export interface Scenario {
  label: string
  detail: string
}

/** What to ask the scenario dock for. */
type Ask = Omit<WeatherRequest, 'seq'>

/** FEMA hazards the scenario dock can play, and what each one opens there. */
const SHORTCUTS: Record<string, { ask: Ask; short: string }> = {
  thunderstorm_wind: { ask: { kind: 'thunderstorm' }, short: 'Thunderstorm' },
  tornado: { ask: { kind: 'tornado' }, short: 'Tornado' },
  ice_storm: { ask: { kind: 'ice' }, short: 'Ice storm' },
  heavy_snow: { ask: { kind: 'blizzard' }, short: 'Heavy snow' },
  winter_storm: { ask: { kind: 'blizzard' }, short: 'Winter storm' },
  riverine_flood: { ask: { kind: 'flood' }, short: 'River flood' },
  flash_flood: { ask: { kind: 'flood' }, short: 'Flash flood' },
  lightning: { ask: { kind: 'lightning' }, short: 'Lightning' },
  high_wind: { ask: { hazard: 'wind' }, short: 'High wind' },
  extreme_heat: { ask: { hazard: 'heat' }, short: 'Extreme heat' },
  extreme_cold: { ask: { hazard: 'cold' }, short: 'Extreme cold' },
}

/** Equipment failures: no weather involved, something on the grid just breaks. */
const FAULTS = Object.values(FAULT_SPECS)

interface Shortcut {
  hazard: Hazard
  ask: Ask
  short: string
}

interface Props {
  disrupted: boolean
  /** What broke, when this page started it. Unknown after a reload or a spoken order. */
  scenario: Scenario | null
  /** Policy being previewed from the branch list, if any. */
  previewName: string | null
  /** Open the scenario dock: arm a storm, or add a condition or fault. Passes the FEMA hazard it came from. */
  onRequest: (ask: Ask, hazard: Hazard | null) => void
  /** Right before the campus is reset, so a running scenario stops first. */
  onResetting?: () => void
  /** The campus was reset. */
  onReset: () => void
}

const pill = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition'

export function ScenarioStrip({ disrupted, scenario, previewName, onRequest, onResetting, onReset }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [list, setList] = useState<HazardList | null>(null)

  useEffect(() => {
    let stop = false
    const pull = () => fetchHazards().then((next) => !stop && setList(next)).catch(() => {})
    void pull()
    // Live alerts change; the engine caches the weather service for five minutes.
    const timer = setInterval(() => void pull(), 5 * 60 * 1000)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [])

  const reset = async () => {
    setBusy(true)
    setError(null)
    onResetting?.()
    try {
      await resetSim()
      onReset()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const conditions = list?.weather.conditions

  return (
    // A fixed height: the running pill is taller than the idle ones, and a growing strip would shift the whole map when a run starts.
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-4">
      {!disrupted ? (
        <>
          <span
            className="mr-1 shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted"
            title={list ? `Natural hazards for ${list.place}. Ranked by ${list.sources}.` : undefined}
          >
            What could hit
          </span>
          <Shortcuts list={list} onRequest={onRequest} />
          {conditions && (
            <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-muted max-[1099px]:hidden" title="National Weather Service, central campus, now">
              {conditions.temperature_f}°F {conditions.summary?.toLowerCase()}
              {list?.weather.alerts.length ? ` · ${list.weather.alerts.length} alert${list.weather.alerts.length > 1 ? 's' : ''}` : ''}
            </span>
          )}
        </>
      ) : (
        <>
          <span className="inline-flex min-w-0 items-center gap-2.5 rounded-full border border-line bg-panel py-1.5 pl-3 pr-1.5 text-xs">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-down" />
            <span className="shrink-0 font-medium">{scenario?.label ?? 'Disrupted'}</span>
            {scenario?.detail && scenario.detail !== scenario.label && <span className="min-w-0 truncate text-muted" title={scenario.detail}>{scenario.detail}</span>}
            <button
              type="button"
              disabled={busy}
              onClick={() => void reset()}
              className="shrink-0 rounded-full bg-ink px-2.5 py-[3px] text-[11px] text-muted transition hover:text-text disabled:opacity-50"
            >
              Reset
            </button>
          </span>
          {previewName && (
            <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-branch bg-panel px-3 py-1.5 text-xs font-medium text-branch">
              <span className="h-1.5 w-1.5 rounded-full bg-branch" />
              Previewing {previewName}
            </span>
          )}
        </>
      )}
      {error && <span className="shrink-0 text-xs text-down">{error}</span>}
    </div>
  )
}

/** As many hazard pills as fit on one row, then a menu with the rest and the equipment failures. */
function Shortcuts({ list, onRequest }: { list: HazardList | null; onRequest: Props['onRequest'] }) {
  const row = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLDivElement>(null)
  const pills = useRef<(HTMLButtonElement | null)[]>([])
  const [fit, setFit] = useState(Infinity)

  const items = useMemo<Shortcut[]>(
    () => (list?.hazards ?? []).flatMap((hazard) => (SHORTCUTS[hazard.id] ? [{ hazard, ...SHORTCUTS[hazard.id] }] : [])),
    [list],
  )
  const active = useMemo(() => new Set(list?.weather.active_hazards ?? []), [list])

  // Pills keep their width whether shown or not, so this settles in one pass.
  useLayoutEffect(() => {
    const box = row.current
    if (!box) return
    const measure = () => {
      const gap = 8
      let used = more.current?.offsetWidth ?? 0
      let count = 0
      for (const button of pills.current.slice(0, items.length)) {
        if (!button || used + gap + button.offsetWidth > box.clientWidth) break
        used += gap + button.offsetWidth
        count += 1
      }
      setFit(count)
    }
    measure()
    // Pills change width when the web font arrives, so watch them too.
    const observer = new ResizeObserver(measure)
    for (const el of [box, more.current, ...pills.current.slice(0, items.length)]) if (el) observer.observe(el)
    return () => observer.disconnect()
  }, [items, active])

  return (
    <div ref={row} className="relative flex min-w-0 flex-1 items-center gap-2">
      {items.map((item, index) => {
        const shown = index < fit
        const warned = active.has(item.hazard.id)
        return (
          <button
            key={item.hazard.id}
            ref={(el) => {
              pills.current[index] = el
            }}
            type="button"
            tabIndex={shown ? undefined : -1}
            aria-hidden={shown ? undefined : true}
            onClick={() => onRequest(item.ask, item.hazard)}
            title={tip(item)}
            className={`${pill} group ${shown ? '' : 'pointer-events-none invisible absolute left-0 top-0'} ${
              warned ? 'border-warn text-warn' : 'border-line bg-panel text-text hover:border-faint'
            }`}
          >
            <AskIcon ask={item.ask} size={14} className={warned ? '' : 'text-muted transition group-hover:text-text'} />
            {item.short}
            {warned && <span className="ml-0.5 font-mono text-[10px] uppercase">warning active</span>}
          </button>
        )
      })}
      <div ref={more} className="shrink-0">
        <MoreMenu
          hazards={items.slice(Math.min(fit, items.length))}
          active={active}
          onHazard={(item) => onRequest(item.ask, item.hazard)}
          onFault={(fault) => onRequest({ fault: fault.kind }, null)}
        />
      </div>
    </div>
  )
}

function MoreMenu({
  hazards,
  active,
  onHazard,
  onFault,
}: {
  hazards: Shortcut[]
  active: ReadonlySet<string>
  onHazard: (item: Shortcut) => void
  onFault: (fault: FaultSpec) => void
}) {
  const id = useId()
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [toRight, setToRight] = useState(false)
  const focusOnOpen = useRef<'first' | 'last' | null>(null)

  const entries = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]

  const show = (focus: 'first' | 'last' | null) => {
    // Open toward whichever side has room inside the main column.
    const here = box.current?.getBoundingClientRect()
    const column = box.current?.closest('main')?.getBoundingClientRect()
    setToRight(Boolean(here && column && here.left + 328 > column.right))
    focusOnOpen.current = focus
    setOpen(true)
  }

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const focus = focusOnOpen.current
    focusOnOpen.current = null
    if (focus) {
      const list = entries()
      list[focus === 'first' ? 0 : list.length - 1]?.focus()
    }
    const onDown = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    // Capture, so the map and the dock cannot swallow the press first.
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  const onButtonKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const edge = event.key === 'ArrowDown' ? 'first' : 'last'
      if (!open) show(edge)
      else entries()[edge === 'first' ? 0 : entries().length - 1]?.focus()
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      close(false)
    }
  }

  const onMenuKey = (event: KeyboardEvent) => {
    const list = entries()
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    const go = (index: number) => {
      event.preventDefault()
      list[(index + list.length) % list.length]?.focus()
    }
    if (event.key === 'ArrowDown') go(at + 1)
    else if (event.key === 'ArrowUp') go(at < 0 ? -1 : at - 1)
    else if (event.key === 'Home') go(0)
    else if (event.key === 'End') go(-1)
    else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if (event.key === 'Tab') setOpen(false)
  }

  const pick = (fn: () => void) => {
    close(true)
    fn()
  }

  return (
    <div ref={box} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(event) => (open ? close(false) : show(event.detail === 0 ? 'first' : null))}
        onKeyDown={onButtonKey}
        className={`${pill} ${open ? 'border-faint bg-raised text-text' : 'border-line bg-panel text-muted hover:border-faint hover:text-text'}`}
      >
        More
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`transition ${open ? 'rotate-180' : ''}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label="More scenarios"
          onKeyDown={onMenuKey}
          className={`absolute top-full z-40 mt-2 w-80 rounded-lg border border-line bg-panel/95 p-1 text-xs text-text shadow-[0_16px_40px_-12px_rgba(0,0,0,0.35)] backdrop-blur-md ${
            toRight ? 'right-0' : 'left-0'
          }`}
        >
          {hazards.length > 0 && (
            <div role="group" aria-label="More hazards" className="border-b border-line pb-1">
              <Heading>More hazards</Heading>
              {hazards.map((item) => {
                const warned = active.has(item.hazard.id)
                return (
                  <button key={item.hazard.id} type="button" role="menuitem" tabIndex={-1} title={tip(item)} onClick={() => pick(() => onHazard(item))} className={entry}>
                    <AskIcon ask={item.ask} size={15} className={`shrink-0 ${warned ? 'text-warn' : 'text-muted'}`} />
                    <span className="min-w-0 flex-1 truncate">{item.hazard.name}</span>
                    {warned ? (
                      <span className="shrink-0 font-mono text-[10px] uppercase text-warn">warning</span>
                    ) : (
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-faint">{often(item.hazard)}</span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
          <div role="group" aria-label="Equipment failure" className={hazards.length > 0 ? 'pt-1' : ''}>
            <Heading>Equipment failure</Heading>
            {FAULTS.map((fault) => (
              <button key={fault.kind} type="button" role="menuitem" tabIndex={-1} title={fault.reason} onClick={() => pick(() => onFault(fault))} className={`${entry} items-start`}>
                <FaultIcon size={15} className="mt-px shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{fault.label}</span>
                  <span className="block text-[11px] leading-snug text-muted">{fault.detail}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const entry = 'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition hover:bg-raised focus:bg-raised'

function Heading({ children }: { children: string }) {
  return (
    <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint" aria-hidden="true">
      {children}
    </div>
  )
}

function AskIcon({ ask, size, className }: { ask: Ask; size: number; className?: string }) {
  if (ask.kind) return <StormIcon kind={ask.kind} size={size} className={className} />
  if (ask.hazard) return <HazardIcon hazard={ask.hazard} size={size} className={className} />
  return <FaultIcon size={size} className={className} />
}

/** FEMA and NOAA facts, then what the click does. */
function tip({ hazard, ask }: Shortcut): string {
  const risk = hazard.risk_rating ? ` FEMA risk: ${hazard.risk_rating}.` : ''
  const rate = hazard.how_often.charAt(0).toUpperCase() + hazard.how_often.slice(1)
  const then = ask.kind ? 'Draw its path on the map.' : `Adds it to the scenario${hazard.effect ? `: ${hazard.effect.label.toLowerCase()}` : ''}.`
  return `${hazard.name}.${risk} ${rate}. ${then}`
}

/** "12 a year", "one every 4 years": the engine's own words, without the hedging. */
function often(hazard: Hazard): string {
  return hazard.how_often.replace(/^about /, '').replace(/ in this county$/, '')
}
