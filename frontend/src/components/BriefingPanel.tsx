import { useEffect, useState } from 'react'
import { fetchPlans, type Briefing, type PriorityMode, type ResponsePlan, type Season } from '../lib/api'

const SEASONS: Season[] = ['fall', 'winter', 'spring', 'summer']

const MODES: { id: PriorityMode; label: string }[] = [
  { id: 'balanced', label: 'Hospital only' },
  { id: 'dorms', label: 'Keep dorms' },
  { id: 'academic', label: 'Keep classes' },
]

export function BriefingPanel({
  briefing,
  onChoose,
  onSeason,
}: {
  briefing: Briefing | null
  onChoose: (mode: PriorityMode) => void | Promise<void>
  onSeason: (season: Season) => void
}) {
  const [plans, setPlans] = useState<ResponsePlan[]>([])
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const disrupted = briefing?.disrupted ?? false

  useEffect(() => {
    if (!disrupted) {
      setPlans([])
      setError(null)
    }
  }, [disrupted])

  if (!briefing) return null

  async function loadPlans() {
    setBusy(true)
    setError(null)
    try {
      const result = await fetchPlans()
      setPlans(result.plans)
    } catch (err) {
      setPlans([])
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const shelterTitle = briefing.shelter.kind === 'cooling' ? 'Open cooling centers?' : 'Open warming centers?'

  async function tryPlan(plan: ResponsePlan) {
    if (!plan.apply || applying !== null) return
    setApplying(plan.rank)
    setError(null)
    try {
      await onChoose(plan.apply)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(null)
    }
  }

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-3">
      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">If this stays dark</h2>
      <div className="mb-2 flex flex-wrap gap-1">
        {SEASONS.map((season) => (
          <button
            key={season}
            type="button"
            onClick={() => onSeason(season)}
            className={`rounded px-2 py-0.5 text-[10px] font-semibold capitalize ${
              briefing.season === season ? 'bg-slate-100 text-slate-950' : 'bg-slate-800 text-slate-400'
            }`}
          >
            {season}
          </button>
        ))}
      </div>

      <p className="text-xs font-semibold text-slate-200">Dorms or classrooms?</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-300">{briefing.priority.answer}</p>
      <p className="mt-1 text-[11px] text-slate-500">
        {briefing.priority.dorms_lit.toLocaleString()} people in lit dorms · {briefing.priority.classrooms_lit.toLocaleString()} in lit classrooms
        {briefing.displaced > 0 ? ` · ${briefing.displaced.toLocaleString()} moved out of dark buildings` : ''}
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {MODES.map((mode) => (
          <button
            key={mode.id}
            onClick={() => onChoose(mode.id)}
            className={`rounded px-2 py-1 text-[11px] font-semibold ${
              briefing.preference === mode.id ? 'bg-sky-400 text-slate-950' : 'bg-slate-800 text-slate-300'
            }`}
          >
            {mode.label}
          </button>
        ))}
      </div>

      <p className="mt-3 text-xs font-semibold text-slate-200">Reroute buses?</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-300">{briefing.buses.answer}</p>
      {briefing.buses.reroute.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1">
          {briefing.buses.reroute.map((route) => (
            <li key={`${route.agency}-${route.id}`} className="text-[11px] leading-relaxed text-slate-400">
              <span className="text-slate-200">
                {route.agency} {route.name}.
              </span>{' '}
              Skip {route.skip.join(', ')}
              {route.keep.length > 0 ? `. Still stops at ${route.keep.join(', ')}` : ''}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-xs font-semibold text-slate-200">{shelterTitle}</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-300">{briefing.shelter.answer}</p>

      <p className="mt-3 text-xs font-semibold text-slate-200">What else moves</p>
      <ul className="mt-1 flex flex-col gap-1">
        {briefing.systems.map((system) => (
          <li key={system.system} className="text-[11px] leading-relaxed text-slate-400">
            <span className={system.status === 'down' ? 'text-red-300' : 'text-emerald-300'}>{system.system}</span>
            {' · '}
            {system.detail}
          </li>
        ))}
      </ul>

      <button
        type="button"
        disabled={!briefing.disrupted || busy}
        onClick={() => void loadPlans()}
        className="mt-3 w-full rounded-md bg-sky-400 px-3 py-2 text-xs font-semibold text-slate-950 disabled:bg-slate-800 disabled:text-slate-500"
      >
        {busy ? 'Ranking plans…' : '5 response plans'}
      </button>
      {!briefing.disrupted && (
        <p className="mt-1 text-[11px] text-slate-500">Fail a building or a feed, then ask the agents for plans.</p>
      )}
      {error && <p className="mt-2 text-[11px] leading-relaxed text-red-300">{error}</p>}
      {plans.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 border-t border-slate-800 pt-3">
          {plans.map((plan) => (
            <article key={plan.rank} className="rounded border border-slate-800 bg-slate-950/60 p-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                #{plan.rank} · {plan.total}/10
              </p>
              <p className="text-xs font-semibold text-slate-100">{plan.title}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-300">{plan.summary}</p>
              <dl className="mt-1 grid grid-cols-3 gap-1 text-[10px] text-slate-400">
                <Score label="Optimal" value={plan.scores.optimal} />
                <Score label="Energy" value={plan.scores.energy} />
                <Score label="Feasible" value={plan.scores.feasibility} />
                <Score label="Cost" value={plan.scores.cost} />
                <Score label="Risk" value={plan.scores.risk} />
                <Score label="People" value={plan.scores.people} />
              </dl>
              <DebriefBlock title="Energy" body={plan.energy} />
              <DebriefBlock title="Transit" body={plan.transit} />
              <DebriefBlock title="Infrastructure" body={plan.infrastructure} />
              <DebriefBlock title="Intervention" body={plan.intervention} />
              <DebriefBlock title="Analysis" body={plan.analysis} />
              {plan.apply && (
                <div className="mt-1">
                  <button
                    type="button"
                    disabled={applying !== null}
                    onClick={() => void tryPlan(plan)}
                    className={`rounded px-2 py-1 text-[10px] font-semibold ${
                      briefing.preference === plan.apply
                        ? 'bg-sky-400 text-slate-950'
                        : 'bg-slate-800 text-sky-300'
                    } disabled:opacity-50`}
                  >
                    {applying === plan.rank
                      ? 'Applying…'
                      : briefing.preference === plan.apply
                        ? 'This allocation is on'
                        : 'Try this allocation'}
                  </button>
                  {briefing.preference === plan.apply && (
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-300">
                      {briefing.priority.answer} {briefing.priority.dorms_lit.toLocaleString()} people in lit dorms ·{' '}
                      {briefing.priority.classrooms_lit.toLocaleString()} in lit classrooms.
                    </p>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function Score({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-semibold text-slate-200">{value}</dd>
    </div>
  )
}

function DebriefBlock({ title, body }: { title: string; body: string }) {
  if (!body) return null
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-300">{body}</p>
    </div>
  )
}

