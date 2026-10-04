import { useEffect, useState } from 'react'
import { adoptStrategy, fetchVerdict, runBranches, type Branch, type BranchResult } from '../lib/api'
import type { PlannedScenario } from '../lib/weather/forecast'
import { STATUS_COLOR, fmtPeople } from '../lib/status'

interface Props {
  /** Heat-wave demo: point at hover, Best, and Adopt. */
  demo?: boolean
  /** The branch under the pointer, so the map can show its end state. Null when none. */
  onPreview: (branch: Branch | null) => void
  onClose: () => void
  onAdopted: () => void
  /** A planned scenario from the dock. Each copy plays it forward before it hits the live campus. */
  scenario?: PlannedScenario | null
  /** Adopt, then play the scenario on the live campus. Offered when a plan is ready and not playing. */
  onAdoptAndRun?: () => void
}

const points = (ratio: number) => Math.round(ratio * 1000) / 10

/** Most people in a lit shelter wins. Fewer people left in the dark breaks a tie. */
function best(branches: Branch[]): string | undefined {
  return [...branches].sort(
    (a, b) =>
      b.metrics.people_in_shelter - a.metrics.people_in_shelter ||
      a.metrics.people_dark - b.metrics.people_dark ||
      b.metrics.shelter_kw - a.metrics.shelter_kw,
  )[0]?.id
}

/** Header for a comparison that played the dock's plan forward. */
function scenarioLine(plan: PlannedScenario, result: BranchResult): string {
  const what = `${plan.events} event${plan.events === 1 ? '' : 's'}, through ${plan.through}`
  const peak = result.through === 'heat peak' ? ', then on to the peak of the heat wave' : ''
  if (plan.running) return `Each policy replays your scenario (${what}) from its start on its own copy${peak}, ${result.ticks} ticks. The live run keeps going.`
  const start = result.fromBaseline ? ' from the campus a run starts from,' : ''
  return `Each policy plays your planned scenario (${what})${start} on its own copy${peak} before anything hits the live campus.`
}

const essentialColor = (ratio: number) => (ratio >= 0.999 ? STATUS_COLOR.Green : ratio >= 0.8 ? STATUS_COLOR.Amber : STATUS_COLOR.Red)

/**
 * Right panel while branching. The engine forks the live state and runs every
 * response policy forward on its own copy; each row is one outcome.
 */
export function BranchPanel({ demo = false, onPreview, onClose, onAdopted, scenario = null, onAdoptAndRun }: Props) {
  const [result, setResult] = useState<BranchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [adopting, setAdopting] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<string | null>(null)
  const [cue, setCue] = useState(demo)

  // The plan as it was when the panel opened. Edits after that need a fresh comparison.
  const [plan] = useState(scenario)
  useEffect(() => {
    runBranches(6, plan?.batches)
      .then(setResult)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [plan])

  useEffect(() => {
    if (!result) return
    const winnerId = best(result.branches)
    if (!winnerId) return
    const kind = (result.shelter ?? (result.season === 'summer' ? 'cooling' : 'warming')) === 'cooling' ? 'cooling center' : 'warming center'
    const winner = result.branches.find((b) => b.id === winnerId)
    if (winner) {
      const dark = winner.metrics.people_dark
      setVerdict(
        `${winner.label} keeps ${fmtPeople(winner.metrics.people_in_shelter)} people in a lit ${kind}, with ${Math.round(winner.metrics.shelter_kw).toLocaleString()} kW serving those buildings. ${fmtPeople(winner.metrics.people_relocated)} people had to leave where they started. ${dark ? `${fmtPeople(dark)} people are still in a dark building.` : 'Nobody is left in a dark building; the transit agent has moved them.'}`,
      )
    }
    void fetchVerdict({
      season: result.season,
      shelter: result.shelter ?? (result.season === 'summer' ? 'cooling' : 'warming'),
      winner: winnerId,
      policies: result.branches.map((b) => ({
        id: b.id,
        label: b.label,
        people_dark: b.metrics.people_dark,
        people_in_shelter: b.metrics.people_in_shelter,
        people_relocated: b.metrics.people_relocated,
        shelter_kw: b.metrics.shelter_kw,
      })),
    })
      .then((next) => setVerdict(next.paragraph))
      .catch(() => {})
  }, [result])

  const adopt = async (id: string, run = false) => {
    setAdopting(id)
    try {
      await adoptStrategy(id)
      if (run && onAdoptAndRun) onAdoptAndRun()
      else onAdopted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setAdopting(null)
    }
  }

  const live = result?.branches.find((b) => b.id === result.active)
  const winner = result ? best(result.branches) : undefined
  const identical = result ? new Set(result.branches.map((b) => JSON.stringify(b.metrics))).size === 1 : false
  const openId = opened ?? winner

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 pb-3 pt-4">
        <div>
          <div className="text-[22px] font-semibold">Branch timeline</div>
          <p className="mt-1 text-[16px] leading-normal text-muted">
            {result && plan && result.through
              ? scenarioLine(plan, result)
              : result
              ? result.throughPeak
                ? `Forked at t${result.baseTick}. Each policy is run to the peak of the heat wave, ${result.ticks} ticks ahead, on its own copy. The live clock is still earlier.`
                : `Forked at t${result.baseTick}. Each policy ran ${result.ticks} ticks on its own copy of the campus with the same agents and supply. The live campus has not changed.`
              : plan
                ? `Playing your planned scenario on five copies of the campus…`
                : 'Forking the live campus and running each response policy…'}
          </p>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 rounded-md border border-line px-2.5 py-[5px] text-sm text-muted transition hover:text-text">
          Back to live <span className="font-mono text-xs">Esc</span>
        </button>
      </div>

      {cue && (
        <div className="border-b border-branch bg-branch/15 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-[16px] font-medium leading-snug">
              Hover a policy to preview the campus at the peak. <span className="text-branch">Best</span> keeps the most people in a cooling center. Adopt it and the live grid follows.
            </p>
            <button type="button" onClick={() => setCue(false)} className="text-[18px] leading-none text-muted" aria-label="Dismiss">
              ×
            </button>
          </div>
        </div>
      )}
      {verdict && (
        <p className="mx-4 mt-3 rounded-md border border-line bg-ink px-3 py-2 text-[16px] leading-normal">{verdict}</p>
      )}
      {error && <p className="mx-4 mt-3 text-sm text-down">{error}</p>}
      {identical && (
        <p className="mx-4 mt-3 rounded-md border border-line bg-ink px-3 py-2 text-sm text-muted">
          {plan
            ? 'Every policy ends in the same place under this plan. Policies only diverge when a feed is short but not dead, so add Extreme cold or Extreme heat to it.'
            : 'Every policy ends in the same place. Policies only diverge when a feed is short but not dead, so try the heat wave scenario.'}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" onMouseLeave={() => onPreview(null)}>
        {result?.branches.map((b, index) => {
          const m = b.metrics
          const isLive = b.id === result.active
          const open = b.id === openId
          const color = essentialColor(m.essential_served)
          const shelterKind = result.shelter ?? (result.season === 'summer' ? 'cooling' : 'warming')
          const delta = live ? m.people_in_shelter - live.metrics.people_in_shelter : 0
          return (
            <div
              key={b.id}
              onMouseEnter={() => {
                setHovered(b.id)
                onPreview(isLive ? null : b)
              }}
              onMouseLeave={() => setHovered(null)}
              onClick={() => setOpened(b.id)}
              className={`rise cursor-pointer border-b border-l-2 border-b-line px-4 py-3.5 ${open ? 'border-l-branch bg-ink' : hovered === b.id ? 'border-l-muted' : 'border-l-transparent'}`}
              style={{ animationDelay: `${index * 60}ms` }}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="whitespace-nowrap text-[18px] font-semibold">{b.label}</span>
                  {isLive && <span className="rounded-[3px] border border-line px-[5px] py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted">Live</span>}
                  {b.id === winner && !identical && <span className="rounded-[3px] bg-branch px-[5px] py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-onbranch">Best</span>}
                </div>
                <span className="text-right font-mono leading-none tabular-nums" style={{ color: b.id === winner && !identical ? 'var(--color-branch)' : color }}>
                  <span className="text-[22px] font-medium">{fmtPeople(m.people_in_shelter)}</span>
                  <span className="mt-1 block text-xs font-sans text-muted">{shelterKind}</span>
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-3.5 font-mono text-[15px] tabular-nums text-muted">
                <span><span className={m.people_dark ? 'text-down' : 'text-text'}>{fmtPeople(m.people_dark)}</span> still dark</span>
                <span><span className="text-text">{Math.round(m.shelter_kw).toLocaleString()} kW</span> at shelters</span>
                <span><span className="text-text">{fmtPeople(m.people_relocated)}</span> moved</span>
                {!isLive && delta !== 0 && (
                  <span className={`ml-auto ${delta > 0 ? 'text-ok' : 'text-down'}`}>
                    {delta > 0 ? '+' : '−'}{fmtPeople(Math.abs(delta))}
                  </span>
                )}
              </div>

              {open && (
                <>
                  <p className="mt-2.5 text-[16px] leading-normal text-muted">{b.description}</p>
                  <dl className="mt-2.5">
                    {([
                      ['People in a lit shelter', fmtPeople(m.people_in_shelter), false],
                      ['Kilowatts at those shelters', `${Math.round(m.shelter_kw).toLocaleString()} kW`, false],
                      ['Still in a dark building', fmtPeople(m.people_dark), m.people_dark > 0],
                      ['Essential demand served', `${points(m.essential_served)}%`, false],
                    ] as const).map(([label, value, bad]) => (
                      <div key={label} className="flex justify-between gap-3 border-t border-line py-[5px] text-[16px]">
                        <dt className="text-muted">{label}</dt>
                        <dd className={`font-mono tabular-nums ${bad ? 'text-down' : ''}`}>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <button
                    type="button"
                    disabled={isLive || adopting !== null}
                    onClick={(event) => {
                      event.stopPropagation()
                      void adopt(b.id)
                    }}
                    className={`mt-3 w-full rounded-md border px-3 py-2 text-base font-semibold ${
                      isLive ? 'border-line text-muted' : 'border-branch bg-branch text-onbranch disabled:opacity-50'
                    }`}
                  >
                    {isLive ? 'Running on the live campus' : adopting === b.id ? 'Adopting…' : 'Adopt this timeline'}
                  </button>
                  {plan && !plan.running && onAdoptAndRun && (
                    <button
                      type="button"
                      disabled={adopting !== null}
                      onClick={(event) => {
                        event.stopPropagation()
                        void adopt(b.id, true)
                      }}
                      className="mt-2 w-full rounded-md border border-branch px-3 py-2 text-base font-semibold text-branch transition enabled:hover:bg-branch/15 disabled:opacity-50"
                    >
                      {isLive ? 'Run the scenario live' : 'Adopt and run the scenario live'}
                    </button>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>

      <p className="border-t border-line px-4 py-3 text-[15px] leading-normal text-muted">
        {plan ? 'Hover a policy to preview the campus once the scenario has played out.' : 'Hover a policy to preview who stays lit.'} The three intakes, the buildings, and the U-M bus lines are real. The kilowatts are a scaled model.
      </p>
    </div>
  )
}
