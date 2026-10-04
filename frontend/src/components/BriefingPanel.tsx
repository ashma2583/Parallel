import { useState } from 'react'
import { fetchDebrief, type Briefing, type Debrief } from '../lib/api'

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
  const [debrief, setDebrief] = useState<Debrief | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

      <div>
        <button
          type="button"
          disabled={!briefing.disrupted || busy}
          onClick={() => void summarize()}
          className="w-full rounded-md border border-branch px-3 py-2 text-[13px] font-semibold text-branch disabled:border-line disabled:text-muted"
        >
          {busy ? 'Writing the summary…' : 'Summarize this scenario'}
        </button>
        {!briefing.disrupted && <p className="mt-1.5 text-[11px] text-muted">Run a scenario, then ask for the read on what happened.</p>}
        {error && <p className="mt-2 text-down">{error}</p>}
      </div>

      {/* Only meaningful while the outage it describes is still on the map. */}
      {debrief && briefing.disrupted && (
        <div className="flex flex-col gap-2.5 border-t border-line pt-3">
          <p className="text-[13px] font-semibold leading-normal">{debrief.headline}</p>
          <DebriefBlock title="Power grid" body={debrief.grid} />
          <DebriefList title="Options from here" items={debrief.options} />
          <DebriefBlock title="Bus routes" body={debrief.buses} />
          <DebriefList title="What to do next" items={debrief.solutions} />
          <DebriefBlock title="Still watching" body={debrief.watch} />
          <p className="text-[11px] text-muted">Written by a language model from the simulation&rsquo;s own numbers.</p>
        </div>
      )}
    </div>
  )
}

function DebriefBlock({ title, body }: { title: string; body: string }) {
  if (!body) return null
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{title}</p>
      <p className="mt-0.5">{body}</p>
    </div>
  )
}

function DebriefList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{title}</p>
      <ul className="mt-0.5 flex list-disc flex-col gap-1 pl-4">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}
