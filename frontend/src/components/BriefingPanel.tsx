import type { Briefing, PriorityMode } from '../lib/api'

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
  if (!briefing) return null

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
    </section>
  )
}
