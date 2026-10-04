import type { Briefing } from '../lib/api'

function Question({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {children}
    </div>
  )
}

/** The outage in plain language, from the engine's /briefing. */
export function BriefingPanel({ briefing }: { briefing: Briefing | null }) {
  if (!briefing) return <p className="text-xs text-muted">Waiting for the engine&rsquo;s briefing.</p>

  const { priority, buses, cooling, systems } = briefing

  return (
    <div className="flex flex-col gap-3.5 text-xs leading-[1.55]">
      <Question title="Dorms or classrooms?">
        <p className="mt-1">{priority.answer}</p>
        <p className="mt-1 font-mono text-[11px] text-muted">
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

      <Question title="Open cooling centers?">
        <p className="mt-1">{cooling.answer}</p>
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
    </div>
  )
}
