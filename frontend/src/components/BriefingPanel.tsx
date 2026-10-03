import type { Briefing } from '../lib/api'

function Question({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[13px] font-semibold">{title}</h3>
      <div className="mt-1 flex flex-col gap-1 text-xs leading-relaxed text-muted">{children}</div>
    </div>
  )
}

/** The outage in plain language. The response policy itself is chosen in the left rail. */
export function BriefingPanel({ briefing }: { briefing: Briefing | null }) {
  if (!briefing) return <p className="text-xs text-faint">Waiting for the engine&rsquo;s briefing.</p>

  const { priority, buses, cooling, systems } = briefing

  return (
    <div className="flex flex-col gap-4">
      <Question title="Dorms or classrooms?">
        <p className="text-text/80">{priority.answer}</p>
        <p className="font-mono text-[11px] text-faint">
          {priority.dorms_lit.toLocaleString()} in lit dorms · {priority.classrooms_lit.toLocaleString()} in lit classrooms
          {briefing.displaced > 0 ? ` · ${briefing.displaced.toLocaleString()} moved` : ''}
        </p>
      </Question>

      <Question title="Reroute buses?">
        <p className="text-text/80">{buses.answer}</p>
        {buses.reroute.map((route) => (
          <p key={`${route.agency}-${route.id}`}>
            <span className="text-text">{route.agency} {route.name}.</span> Skip {route.skip.join(', ')}
            {route.keep.length > 0 ? `. Still stops at ${route.keep.join(', ')}` : ''}
          </p>
        ))}
      </Question>

      <Question title="Open cooling centers?">
        <p className="text-text/80">{cooling.answer}</p>
      </Question>

      <Question title="What else moves">
        {systems.map((system) => (
          <p key={system.system}>
            <span className={system.status === 'down' ? 'text-down' : 'text-ok'}>{system.system}</span>
            {' · '}
            {system.detail}
          </p>
        ))}
      </Question>
    </div>
  )
}
