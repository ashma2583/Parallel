import { useState } from 'react'
import { disrupt, resetSim, startHeatWave, type DisruptAction } from '../lib/api'

interface Step {
  nodeIds: string[]
  action: DisruptAction
  factor?: number
}

export interface Scenario {
  label: string
  detail: string
  /** Logged to the agent feed as the Director's reason. */
  reason?: string
  steps?: Step[]
}

export const HEAT_WAVE: Required<Scenario> = {
  label: 'Heat wave, 95°F',
  detail: 'Output falls for 4 hours, to 35% at the plant and 50% on the north feed',
  reason: 'Heat wave derates campus generation',
  steps: [],
}

const OTHER_SCENARIOS: Required<Scenario>[] = [
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

export async function runScenario(scenario: Required<Scenario>) {
  if (scenario.label === HEAT_WAVE.label) {
    await startHeatWave()
    return
  }
  for (const step of scenario.steps) {
    await disrupt(step.nodeIds, step.action, scenario.reason, step.factor)
  }
}

interface Props {
  disrupted: boolean
  /** What broke, when this page started it. Unknown after a reload or a spoken order. */
  scenario: Scenario | null
  /** Policy being previewed from the branch list, if any. */
  previewName: string | null
  onScenario: (scenario: Scenario | null) => void
  onChanged: () => void
}

export function ScenarioStrip({ disrupted, scenario, previewName, onScenario, onChanged }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const play = (s: Required<Scenario>) =>
    run(async () => {
      await runScenario(s)
      if (s.label === HEAT_WAVE.label) sessionStorage.setItem('parallel-scenario', 'heat-wave')
      else sessionStorage.removeItem('parallel-scenario')
      onScenario(s)
    })

  const reset = () =>
    run(async () => {
      await resetSim()
      sessionStorage.removeItem('parallel-scenario')
      onScenario(null)
    })

  return (
    <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-3">
      {!disrupted ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => play(HEAT_WAVE)}
            title={HEAT_WAVE.detail}
            className="whitespace-nowrap rounded-full bg-down px-3 py-1.5 text-xs font-semibold text-onbranch disabled:opacity-50"
          >
            {HEAT_WAVE.label}
          </button>
          <details className="text-xs text-muted">
            <summary className="cursor-pointer px-1">Other outages</summary>
            <span className="ml-1 inline-flex flex-wrap gap-2 pt-1">
              {OTHER_SCENARIOS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  disabled={busy}
                  onClick={() => play(s)}
                  title={s.detail}
                  className="whitespace-nowrap rounded-full border border-line bg-panel px-3 py-1.5 text-xs font-medium text-text transition hover:border-down hover:text-down disabled:opacity-50"
                >
                  {s.label}
                </button>
              ))}
            </span>
          </details>
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
