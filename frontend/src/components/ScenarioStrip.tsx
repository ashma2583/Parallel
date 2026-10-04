import { useState } from 'react'
import { disrupt, resetSim, type DisruptAction } from '../lib/api'

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

const SCENARIOS: Required<Scenario>[] = [
  {
    label: 'Heat wave, 95°F',
    detail: 'Power plant at 35%, north feed at 50%',
    reason: 'Heat wave derates campus generation',
    steps: [
      { nodeIds: ['cpp'], action: 'derate', factor: 0.35 },
      { nodeIds: ['north_switch'], action: 'derate', factor: 0.5 },
    ],
  },
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
      for (const step of s.steps) await disrupt(step.nodeIds, step.action, s.reason, step.factor)
      onScenario(s)
    })

  const reset = () =>
    run(async () => {
      await resetSim()
      onScenario(null)
    })

  return (
    <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-3">
      {!disrupted ? (
        <>
          <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Break something</span>
          {SCENARIOS.map((s) => (
            <button
              key={s.label}
              type="button"
              disabled={busy}
              onClick={() => play(s)}
              title={s.detail}
              className="whitespace-nowrap rounded-full border border-line bg-panel px-3 py-1.5 text-xs font-medium transition hover:border-down hover:text-down disabled:opacity-50"
            >
              {s.label}
            </button>
          ))}
          <span className="ml-1 text-xs text-muted max-[1099px]:hidden">or click any building to fail it</span>
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
