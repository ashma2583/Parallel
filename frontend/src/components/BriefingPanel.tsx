import { useEffect, useState } from 'react'
import { adoptStrategy, fetchDebrief, fetchPlans, setSeason, type Briefing, type Debrief, type ResponsePlan, type Season } from '../lib/api'
import { strategyFor } from '../lib/strategies'

const SEASONS: Season[] = ['fall', 'winter', 'spring', 'summer']

const SCORES: { key: keyof ResponsePlan['scores']; label: string }[] = [
  { key: 'optimal', label: 'optimal' },
  { key: 'energy', label: 'energy' },
  { key: 'feasibility', label: 'feasible' },
  { key: 'cost', label: 'cost' },
  { key: 'risk', label: 'risk' },
  { key: 'people', label: 'people' },
]

function Question({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[18px] font-semibold">{title}</h3>
      {children}
    </div>
  )
}

/** The outage in plain language, plus ranked plans the desk can try. */
export function BriefingPanel({ briefing, extras = false, onChanged }: { briefing: Briefing | null; extras?: boolean; onChanged?: () => void }) {
  const [debrief, setDebrief] = useState<Debrief | null>(null)
  const [plans, setPlans] = useState<ResponsePlan[]>([])
  const [busy, setBusy] = useState<'summary' | 'plans' | null>(null)
  const [applying, setApplying] = useState<number | null>(null)
  const [applied, setApplied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const disrupted = briefing?.disrupted ?? false

  useEffect(() => {
    if (!disrupted) {
      setPlans([])
      setDebrief(null)
      setApplied(null)
      setError(null)
    }
  }, [disrupted])

  if (!briefing) return <p className="text-sm text-muted">Waiting for the engine&rsquo;s briefing.</p>

  const shelter = briefing.shelter ?? briefing.cooling
  const shelterKind = shelter.kind ?? (briefing.season === 'summer' ? 'cooling' : 'warming')
  const season = briefing.season ?? 'fall'
  const { priority, buses, systems } = briefing

  async function summarize() {
    setBusy('summary')
    setError(null)
    try {
      setDebrief(await fetchDebrief())
    } catch (err) {
      setDebrief(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function loadPlans() {
    setBusy('plans')
    setError(null)
    try {
      setPlans((await fetchPlans()).plans)
    } catch (err) {
      setPlans([])
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function chooseSeason(next: Season) {
    setError(null)
    try {
      await setSeason(next)
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function tryPlan(plan: ResponsePlan) {
    if (!plan.apply || applying !== null) return
    setApplying(plan.rank)
    setError(null)
    try {
      await adoptStrategy(plan.apply)
      setApplied(plan.apply)
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(null)
    }
  }

  return (
    <div className="flex flex-col gap-3.5 text-[16px] leading-[1.5]">
      <Question title="Season">
        <div className="mt-1.5 flex gap-1">
          {SEASONS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => void chooseSeason(item)}
              className={`rounded px-2 py-1 text-sm font-semibold capitalize ${
                season === item ? 'bg-branch text-onbranch' : 'border border-line text-muted'
              }`}
            >
              {item}
            </button>
          ))}
        </div>
      </Question>

      <Question title="Dorms or classrooms?">
        <p className="mt-1">{priority.answer}</p>
        <p className="mt-1 font-mono text-sm text-muted">
          {priority.dorms_lit.toLocaleString()} in lit dorms · {priority.classrooms_lit.toLocaleString()} in lit classrooms
          {briefing.displaced > 0 ? ` · ${briefing.displaced.toLocaleString()} moved` : ''}
        </p>
      </Question>

      <Question title="Reroute buses?">
        <p className="mt-1">{buses.answer}</p>
        {buses.reroute.map((route) => (
          <p key={`${route.agency}-${route.id}`} className="mt-1 text-muted">
            <span className="text-text">{route.agency} {route.name}.</span> Skip {route.skip.join(', ')}
            {route.keep.length > 0 ? `. Still stops at ${route.keep.join(', ')}` : ''}
          </p>
        ))}
      </Question>

      <Question title={shelterKind === 'cooling' ? 'Open cooling centers?' : 'Open warming centers?'}>
        <p className="mt-1">{shelter.answer}</p>
      </Question>

      <Question title="What else moves">
        {systems.map((system) => (
          <p key={system.system} className="mt-1 text-muted">
            <span className={system.status === 'down' ? 'text-down' : 'text-ok'}>{system.system}</span>
            {' · '}
            {system.detail}
          </p>
        ))}
      </Question>

      {extras && <div className="flex flex-col gap-2">
        <button
          type="button"
          disabled={!disrupted || busy !== null}
          onClick={() => void loadPlans()}
          className="w-full rounded-md bg-branch px-3 py-2 text-base font-semibold text-onbranch disabled:bg-line disabled:text-muted"
        >
          {busy === 'plans' ? 'Writing five plans…' : '5 response plans'}
        </button>
        <button
          type="button"
          disabled={!disrupted || busy !== null}
          onClick={() => void summarize()}
          className="w-full rounded-md border border-branch px-3 py-2 text-base font-semibold text-branch disabled:border-line disabled:text-muted"
        >
          {busy === 'summary' ? 'Writing the summary…' : 'Summarize this scenario'}
        </button>
        {!disrupted && <p className="text-sm text-muted">Run a scenario, then ask for plans or a summary.</p>}
        {error && <p className="text-down">{error}</p>}
      </div>}

      {extras && plans.length > 0 && disrupted && (
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          {plans.map((plan) => (
            <article key={plan.rank} className="rounded-md border border-line p-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <h4 className="text-base font-semibold">
                  {plan.rank}. {plan.title}
                </h4>
                <span className="font-mono text-sm text-muted">{plan.total.toFixed(1)}</span>
              </div>
              <p className="mt-1">{plan.summary}</p>
              <dl className="mt-2 grid grid-cols-3 gap-1 font-mono text-xs text-muted">
                {SCORES.map((score) => (
                  <div key={score.key}>
                    {score.label} <span className="text-text">{plan.scores[score.key]}</span>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-muted">{plan.analysis}</p>
              {plan.apply && (
                <button
                  type="button"
                  disabled={applying !== null}
                  onClick={() => void tryPlan(plan)}
                  className="mt-2 rounded border border-branch px-2 py-1 text-sm font-semibold text-branch disabled:opacity-40"
                >
                  {applying === plan.rank
                    ? 'Applying…'
                    : applied === plan.apply
                      ? `This allocation is on · ${strategyFor(plan.apply).label}`
                      : `Try this allocation · ${strategyFor(plan.apply).label}`}
                </button>
              )}
            </article>
          ))}
          <p className="text-sm text-muted">Scores are 1–10. Higher is better on every score, including cost and risk. Written from the simulation&rsquo;s own numbers.</p>
        </div>
      )}

      {debrief && disrupted && (
        <div className="flex flex-col gap-2.5 border-t border-line pt-3">
          <p className="text-base font-semibold leading-normal">{debrief.headline}</p>
          <DebriefBlock title="Power grid" body={debrief.grid} />
          <DebriefList title="Options from here" items={debrief.options} />
          <DebriefBlock title="Bus routes" body={debrief.buses} />
          <DebriefList title="What to do next" items={debrief.solutions} />
          <DebriefBlock title="Still watching" body={debrief.watch} />
          <p className="text-sm text-muted">Written by a language model from the simulation&rsquo;s own numbers.</p>
        </div>
      )}
    </div>
  )
}

function DebriefBlock({ title, body }: { title: string; body: string }) {
  if (!body) return null
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{title}</p>
      <p className="mt-0.5">{body}</p>
    </div>
  )
}

function DebriefList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{title}</p>
      <ul className="mt-0.5 flex list-disc flex-col gap-1 pl-4">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}
