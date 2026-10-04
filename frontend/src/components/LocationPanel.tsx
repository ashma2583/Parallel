import { useState } from 'react'
import { researchLocation, type LocationSurvey } from '../lib/api'
import type { SurveyGraphModel } from '../lib/surveyGraph'

export function LocationPanel({
  onShow,
  onClear,
  graph,
  dark,
  onToggle,
}: {
  onShow: (survey: LocationSurvey) => void
  onClear: () => void
  graph: SurveyGraphModel | null
  dark: ReadonlySet<string>
  onToggle: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [survey, setSurvey] = useState<LocationSurvey | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function research() {
    const text = query.trim()
    if (text.length < 2) return
    setBusy(true)
    setError(null)
    try {
      const found = await researchLocation(text)
      setSurvey(found)
      onShow(found)
    } catch (err) {
      setSurvey(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Add a location</h2>
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          void research()
        }}
      >
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="a campus, or one building"
          className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
        />
        <button
          type="submit"
          disabled={busy || query.trim().length < 2}
          className="rounded bg-sky-400 px-2 py-1.5 text-xs font-semibold text-slate-950 disabled:bg-slate-800 disabled:text-slate-500"
        >
          {busy ? '…' : 'Research'}
        </button>
      </form>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        A campus returns the 15–20 buildings that matter in an outage, and the lines that connect them.
      </p>
      {error && <p className="mt-2 text-[11px] leading-relaxed text-red-300">{error}</p>}
      {survey && (
        <div className="mt-2 rounded-md border border-slate-800 bg-slate-900/80 p-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-slate-100">{survey.name}</p>
            <button type="button" onClick={onClear} className="text-[10px] font-semibold text-slate-400 hover:text-slate-200">
              Clear
            </button>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-300">{survey.summary}</p>
          <p className="mt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            {survey.buildings.length} buildings
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            Click a building to take it offline. The plant feeds the campus. A hospital keeps its own supply.
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {(graph?.nodes ?? []).map((node) => {
              const feeder = graph?.nodes.find((item) => item.id === node.feed)
              const down = dark.has(node.id)
              return (
                <li key={node.id}>
                  <button
                    type="button"
                    onClick={() => onToggle(node.id)}
                    className="w-full rounded px-1 py-0.5 text-left text-[11px] leading-relaxed text-slate-400 hover:bg-slate-800"
                  >
                    <span className={down ? 'text-red-300' : 'text-slate-200'}>{node.name}</span>
                    {down ? ' · offline' : ''}
                    {' · '}
                    {feeder ? `fed by ${feeder.name}` : 'own supply'}
                  </button>
                </li>
              )
            })}
          </ul>
          {survey.transit.length > 0 && (
            <>
              <p className="mt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Core lines</p>
              <ul className="mt-1 flex flex-col gap-1">
                {survey.transit.map((line) => (
                  <li key={`${line.agency}-${line.name}`} className="text-[11px] leading-relaxed text-slate-400">
                    <span className="text-slate-200">
                      {line.agency ? `${line.agency} ` : ''}
                      {line.name}
                    </span>
                    {line.connects ? ` · ${line.connects}` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
          {survey.sources.length > 0 && (
            <ul className="mt-2 flex flex-col gap-0.5">
              {survey.sources.map((url) => (
                <li key={url} className="truncate text-[10px] text-sky-300">
                  <a href={url} target="_blank" rel="noreferrer">
                    {url.replace(/^https?:\/\//, '')}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
