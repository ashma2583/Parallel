import { useEffect, useState } from 'react'
import { applyHazard, disrupt, fetchHazards, resetSim, type DisruptAction, type Hazard, type HazardList } from '../lib/api'

interface Step {
  nodeIds: string[]
  action: DisruptAction
  factor?: number
}

export interface Scenario {
  label: string
  detail: string
}

interface Failure extends Scenario {
  reason: string
  steps: Step[]
}

/** Equipment failures: no weather involved, something on the grid just breaks. */
const FAILURES: Failure[] = [
  {
    label: 'Central Power Plant trips',
    detail: 'Central campus loses its only feed',
    reason: 'Central campus generation trips offline',
    steps: [{ nodeIds: ['cpp'], action: 'fail' }],
  },
  {
    label: 'North campus feed opens',
    detail: 'Only NCRC has generation of its own',
    reason: 'DTE campus substation feed opens',
    steps: [{ nodeIds: ['north_switch'], action: 'fail' }],
  },
  {
    label: 'Hospital switchgear fails',
    detail: 'Medical campus falls back to the emergency tie',
    reason: 'University Hospital intake fails',
    steps: [{ nodeIds: ['uh'], action: 'fail' }],
  },
  {
    label: 'All three intakes drop',
    detail: 'Regional outage',
    reason: 'All three campus intakes drop',
    steps: [{ nodeIds: ['cpp', 'uh', 'north_switch'], action: 'fail' }],
  },
]

/** Pills shown before the rest fold into the "More" menu. */
const VISIBLE_HAZARDS = 6

interface Props {
  disrupted: boolean
  /** What broke, when this page started it. Unknown after a reload or a spoken order. */
  scenario: Scenario | null
  /** Policy being previewed from the branch list, if any. */
  previewName: string | null
  onScenario: (scenario: Scenario | null) => void
  /** The hazard that was run, so the briefing can explain it. Null on reset. */
  onHazard: (hazard: Hazard | null) => void
  onChanged: () => void
}

const pill = 'whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50'

export function ScenarioStrip({ disrupted, scenario, previewName, onScenario, onHazard, onChanged }: Props) {
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

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const playHazard = (hazard: Hazard) =>
    run(async () => {
      await applyHazard(hazard.id)
      onScenario({ label: hazard.name, detail: `Assumed: ${hazard.effect?.label.toLowerCase() ?? 'no effect'}` })
      onHazard(hazard)
    })

  const playFailure = (failure: Failure) =>
    run(async () => {
      for (const step of failure.steps) await disrupt(step.nodeIds, step.action, failure.reason, step.factor)
      onScenario(failure)
      onHazard(null)
    })

  const reset = () =>
    run(async () => {
      await resetSim()
      onScenario(null)
      onHazard(null)
    })

  const runnable = (list?.hazards ?? []).filter((h) => h.effect)
  const shown = runnable.slice(0, VISIBLE_HAZARDS)
  const more = runnable.slice(VISIBLE_HAZARDS)
  const active = new Set(list?.weather.active_hazards ?? [])
  const conditions = list?.weather.conditions

  return (
    <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-3">
      {!disrupted ? (
        <>
          <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted" title={list ? `Natural hazards for ${list.place}. Ranked by ${list.sources}.` : undefined}>
            What could hit
          </span>
          {shown.map((h) => (
            <button
              key={h.id}
              type="button"
              disabled={busy}
              onClick={() => playHazard(h)}
              title={`${h.risk_rating ? `FEMA risk: ${h.risk_rating}. ` : ''}${h.how_often}. Assumed effect: ${h.effect?.label.toLowerCase()}`}
              className={`${pill} ${active.has(h.id) ? 'border-warn text-warn' : 'border-line bg-panel hover:border-down hover:text-down'}`}
            >
              {h.name}
              {active.has(h.id) && <span className="ml-1.5 font-mono text-[10px] uppercase">warning active</span>}
            </button>
          ))}
          <select
            id="more-scenarios"
            aria-label="More scenarios"
            disabled={busy}
            value=""
            onChange={(event) => {
              const hazard = more.find((h) => h.id === event.target.value)
              const failure = FAILURES.find((f) => f.label === event.target.value)
              if (hazard) void playHazard(hazard)
              else if (failure) void playFailure(failure)
            }}
            className={`${pill} w-[88px] border-line bg-panel pr-1`}
          >
            <option value="" disabled>More…</option>
            {more.length > 0 && (
              <optgroup label="Less common here">
                {more.map((h) => (
                  <option key={h.id} value={h.id}>{h.name}</option>
                ))}
              </optgroup>
            )}
            <optgroup label="Equipment failure">
              {FAILURES.map((f) => (
                <option key={f.label} value={f.label}>{f.label}</option>
              ))}
            </optgroup>
          </select>
          {conditions && (
            <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-muted max-[1099px]:hidden" title="National Weather Service, central campus, now">
              {conditions.temperature_f}°F {conditions.summary?.toLowerCase()}
              {list?.weather.alerts.length ? ` · ${list.weather.alerts.length} alert${list.weather.alerts.length > 1 ? 's' : ''}` : ''}
            </span>
          )}
        </>
      ) : (
        <>
          <span className="inline-flex items-center gap-2.5 rounded-full border border-line bg-panel py-1.5 pl-3 pr-1.5 text-xs">
            <span className="h-1.5 w-1.5 rounded-full bg-down" />
            <span className="font-medium">{scenario?.label ?? 'Disrupted'}</span>
            {scenario?.detail && <span className="text-muted">{scenario.detail}</span>}
            <button
              type="button"
              disabled={busy}
              onClick={reset}
              className="rounded-full bg-ink px-2.5 py-[3px] text-[11px] text-muted transition hover:text-text disabled:opacity-50"
            >
              Reset
            </button>
          </span>
          {previewName && (
            <span className="inline-flex items-center gap-2 rounded-full border border-branch bg-panel px-3 py-1.5 text-xs font-medium text-branch">
              <span className="h-1.5 w-1.5 rounded-full bg-branch" />
              Previewing {previewName}
            </span>
          )}
        </>
      )}
      {error && <span className="text-xs text-down">{error}</span>}
    </div>
  )
}
