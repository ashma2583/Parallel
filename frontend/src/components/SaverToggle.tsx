import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { WEEKDAYS, applySaver, clearSaver, fetchSaverPlan, hhmm, type SaverLive, type SaverPolicy } from '../lib/saver'

interface Props {
  /** The saver on the live clock. Null when off. */
  live: SaverLive | null
  /** Where a new run starts: the People day and time unless changed here. */
  weekday: string
  minute: number
  onWhen: (next: { weekday?: string; minute?: number }) => void
  onChanged: () => void
  /** Open the heatmap, assumptions and policy comparison. */
  onDetails: () => void
}

const LEVELS: { id: SaverPolicy; label: string; sub: string }[] = [
  { id: 'comfort', label: 'Comfort', sub: 'Classrooms and libraries, 20% headroom' },
  { id: 'balanced', label: 'Balanced', sub: 'Adds dining halls and labs, 10% headroom' },
  { id: 'aggressive', label: 'Aggressive', sub: 'Adds residence halls, no headroom' },
]
const MINUTES = Array.from({ length: 48 }, (_, i) => i * 30)

const item = 'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition hover:bg-raised focus:bg-raised disabled:opacity-50'

/**
 * Energy saver as a focus you switch on: Off / Comfort / Balanced / Aggressive.
 * Runs on top of whatever scenario is playing. A pill in the scenario strip with a small menu.
 */
export function SaverToggle({ live, weekday, minute, onWhen, onChanged, onDetails }: Props) {
  const id = useId()
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [insight, setInsight] = useState<string | null>(null)

  // One line on where the savings come from, for the level that is running.
  const policy = live?.policy
  const day = live?.weekday
  useEffect(() => {
    if (!open || !policy || !day) return
    let stop = false
    fetchSaverPlan(day, policy)
      .then((plan) => !stop && setInsight(plan.insight))
      .catch(() => !stop && setInsight(null))
    return () => {
      stop = true
    }
  }, [open, policy, day])

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    // Capture, so the map cannot swallow the press first.
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  const entries = () => [...(menu.current?.querySelectorAll<HTMLElement>('[data-entry]') ?? [])]

  const choose = async (next: 'off' | SaverPolicy) => {
    if ((next === 'off' && !live) || next === live?.policy) {
      setOpen(false)
      button.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (next === 'off') await clearSaver()
      // A level change while running carries on from the saver's own clock.
      else await applySaver(next, live ? live.weekday : weekday, live ? live.minute : minute)
      onChanged()
      setOpen(false)
      button.current?.focus()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      button.current?.focus()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const list = entries()
    const at = list.indexOf(document.activeElement as HTMLElement)
    event.preventDefault()
    const to = event.key === 'ArrowDown' ? at + 1 : at < 0 ? -1 : at - 1
    list[(to + list.length) % list.length]?.focus()
  }

  const on = live !== null
  const capped = live ? Object.keys(live.caps).length : 0

  return (
    <div ref={box} className="relative shrink-0" onKeyDown={onKey}>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        title={on ? `Energy saver on: ${live.policy_label}. Buildings people are not using are capped.` : 'Cap power in buildings people are not using'}
        className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition ${
          on ? 'border-flow bg-panel text-text' : open ? 'border-faint bg-raised text-text' : 'border-line bg-panel text-muted hover:border-faint hover:text-text'
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${on ? 'bg-flow' : 'bg-line'}`} />
        Energy saver
        <span className={on ? 'text-text' : 'text-faint'}>{on ? live.policy_label : 'Off'}</span>
        {on && <span className="font-mono text-[11px] tabular-nums text-muted max-[1199px]:hidden">−{Math.round(live.kw_saved_now)} kW</span>}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`transition ${open ? 'rotate-180' : ''}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label="Energy saver"
          className="absolute right-0 top-full z-40 mt-2 w-80 rounded-lg border border-line bg-panel/95 p-1 text-xs text-text shadow-[0_16px_40px_-12px_rgba(0,0,0,0.35)] backdrop-blur-md"
        >
          <div role="group" aria-label="Level">
            <button type="button" role="menuitemradio" aria-checked={!on} data-entry disabled={busy} onClick={() => void choose('off')} className={item}>
              <Mark checked={!on} />
              <span className="min-w-0 flex-1">
                <span className="block">Off</span>
                <span className="block text-[11px] leading-snug text-muted">Every building at full power</span>
              </span>
            </button>
            {LEVELS.map((level) => (
              <button key={level.id} type="button" role="menuitemradio" aria-checked={live?.policy === level.id} data-entry disabled={busy} onClick={() => void choose(level.id)} className={item}>
                <Mark checked={live?.policy === level.id} />
                <span className="min-w-0 flex-1">
                  <span className="block">{level.label}</span>
                  <span className="block text-[11px] leading-snug text-muted">{level.sub}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="mt-1 border-t border-line px-2 pb-1 pt-2">
            {live ? (
              <>
                <div className="font-mono text-[11px] tabular-nums text-muted">
                  {live.weekday} {live.clock} · <span className="text-text">{capped}</span> capped · <span className="text-text">{live.kwh_saved.toFixed(1)} kWh</span> saved
                </div>
                {insight && <p className="mt-1.5 border-l-2 border-flow pl-2 text-[12px] leading-snug">{insight}</p>}
              </>
            ) : (
              <div className="flex items-center gap-2 text-[11px] text-muted" title="Taken from the People day and time. Change it here to start elsewhere.">
                <span className="shrink-0">Starts</span>
                <select
                  aria-label="Day"
                  value={weekday}
                  onChange={(e) => onWhen({ weekday: e.target.value })}
                  className="rounded-md border border-line bg-ink px-1.5 py-1 text-xs text-text"
                >
                  {WEEKDAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <select
                  aria-label="Start time"
                  value={minute}
                  onChange={(e) => onWhen({ minute: Number(e.target.value) })}
                  className="rounded-md border border-line bg-ink px-1.5 py-1 font-mono text-xs text-text"
                >
                  {MINUTES.map((m) => <option key={m} value={m}>{hhmm(m)}</option>)}
                </select>
              </div>
            )}
            {error && <p className="mt-1.5 text-[11px] text-down">{error}</p>}
          </div>

          <button
            type="button"
            role="menuitem"
            data-entry
            onClick={() => {
              setOpen(false)
              onDetails()
            }}
            className={`${item} justify-between border-t border-line`}
          >
            <span>Details</span>
            <span className="truncate text-[11px] text-muted">heatmap, assumptions</span>
          </button>
        </div>
      )}
    </div>
  )
}

function Mark({ checked }: { checked: boolean }) {
  return (
    <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${checked ? 'border-flow' : 'border-faint'}`} aria-hidden="true">
      {checked && <span className="h-1.5 w-1.5 rounded-full bg-flow" />}
    </span>
  )
}
