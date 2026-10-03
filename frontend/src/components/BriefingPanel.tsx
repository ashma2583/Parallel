import { useEffect, useState } from 'react'
import { fetchDebrief, type Briefing, type Debrief, type PriorityMode } from '../lib/api'

const MODES: { id: PriorityMode; label: string }[] = [
  { id: 'balanced', label: 'Hospital only' },
  { id: 'dorms', label: 'Keep dorms' },
  { id: 'academic', label: 'Keep classes' },
]

export function BriefingPanel({
  briefing,
  onChoose,
}: {
  briefing: Briefing | null
  onChoose: (mode: PriorityMode) => void
}) {
  const [debrief, setDebrief] = useState<Debrief | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const disrupted = briefing?.disrupted ?? false

  useEffect(() => {
    if (!disrupted) {
      setDebrief(null)
      setError(null)
    }
  }, [disrupted])

  if (!briefing) return null

  async function summarize() {
    setBusy(true)
    setError(null)
    try {
      setDebrief(await fetchDebrief())
    } catch (err) {
      setDebrief(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-3">
      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">If this stays dark</h2>

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

      <p className="mt-3 text-xs font-semibold text-slate-200">Open cooling centers?</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-300">{briefing.cooling.answer}</p>

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
        onClick={() => void summarize()}
        className="mt-3 w-full rounded-md bg-sky-400 px-3 py-2 text-xs font-semibold text-slate-950 disabled:bg-slate-800 disabled:text-slate-500"
      >
        {busy ? 'Writing the summary…' : 'Summarize this scenario'}
      </button>
      {!briefing.disrupted && (
        <p className="mt-1 text-[11px] text-slate-500">Run a scenario, then ask for the read on what happened.</p>
      )}
      {error && <p className="mt-2 text-[11px] leading-relaxed text-red-300">{error}</p>}
      {debrief && (
        <div className="mt-3 flex flex-col gap-2 border-t border-slate-800 pt-3">
          <p className="text-xs font-semibold leading-relaxed text-slate-100">{debrief.headline}</p>
          <DebriefBlock title="Power grid" body={debrief.grid} />
          <DebriefList title="Options from here" items={debrief.options} />
          <DebriefBlock title="Bus routes" body={debrief.buses} />
          <DebriefList title="What to do next" items={debrief.solutions} />
          {debrief.watch && <DebriefBlock title="Still watching" body={debrief.watch} />}
        </div>
      )}
    </section>
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

function DebriefList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</p>
      <ul className="mt-0.5 flex flex-col gap-1">
        {items.map((item) => (
          <li key={item} className="text-[11px] leading-relaxed text-slate-300">
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}
