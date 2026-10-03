import { useState } from 'react'
import { adoptStrategy, disrupt, resetSim, type DisruptAction } from '../lib/api'
import type { Sim } from '../lib/sim'

interface Step {
  nodeIds: string[]
  action: DisruptAction
  factor?: number
}

interface Scenario {
  label: string
  detail: string
  reason: string
  steps: Step[]
}

const SCENARIOS: Scenario[] = [
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

/** Mirrors STRATEGIES in backend/agents/logic.py. */
const STRATEGY_LABEL: Record<string, string> = {
  tiered: 'Priority tiers',
  residential: 'Protect residential',
  people: 'Most people per kW',
  even: 'Ration evenly',
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{children}</h2>
}

export function DisruptRail({ sim }: { sim: Sim }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      sim.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const play = (s: Scenario) =>
    run(async () => {
      for (const step of s.steps) await disrupt(step.nodeIds, step.action, s.reason, step.factor)
    })

  const failed = sim.nodes.filter((n) => n.failed)

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-7 overflow-y-auto border-r border-line bg-panel p-4">
      <section>
        <Heading>Break something</Heading>
        <div className="flex flex-col gap-1.5">
          {SCENARIOS.map((s) => (
            <button
              key={s.label}
              type="button"
              disabled={busy}
              onClick={() => play(s)}
              className="rounded-md border border-line bg-raised px-3 py-2 text-left transition hover:border-down/70 disabled:opacity-50"
            >
              <div className="text-[13px] font-medium">{s.label}</div>
              <div className="text-xs text-muted">{s.detail}</div>
            </button>
          ))}
        </div>
        <p className="mt-2.5 text-xs text-faint">Or click any building on the map and fail it.</p>
        {error && <p className="mt-2 text-xs text-down">{error}</p>}
      </section>

      <section>
        <Heading>Response policy</Heading>
        <div className="flex flex-col gap-1">
          {Object.entries(STRATEGY_LABEL).map(([id, label]) => {
            const active = id === sim.strategy
            return (
              <button
                key={id}
                type="button"
                disabled={busy || active}
                onClick={() => run(() => adoptStrategy(id))}
                className={`flex items-center gap-2.5 rounded-md px-3 py-1.5 text-left text-[13px] transition ${
                  active ? 'bg-branch/15 font-medium text-text' : 'text-muted hover:bg-raised hover:text-text'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-branch' : 'bg-line'}`} />
                {label}
              </button>
            )
          })}
        </div>
        <p className="mt-2.5 text-xs text-faint">The energy agent sheds load in this order. Branch the timeline to compare all four before choosing.</p>
      </section>

      <section className="mt-auto">
        {failed.length > 0 && (
          <>
            <Heading>Offline ({failed.length})</Heading>
            <ul className="mb-3 flex flex-col gap-1 text-xs">
              {failed.map((n) => (
                <li key={n.id} className="flex items-center justify-between gap-2 text-muted">
                  <span className="truncate">{n.name}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(() => disrupt([n.id], 'restore'))}
                    className="shrink-0 font-medium text-ok hover:underline disabled:opacity-50"
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => run(resetSim)}
          className="w-full rounded-md border border-line px-3 py-2 text-[13px] font-medium text-muted transition hover:border-ok/60 hover:text-ok disabled:opacity-50"
        >
          Reset campus
        </button>
      </section>
    </aside>
  )
}
