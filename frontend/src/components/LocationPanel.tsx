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
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-[0.14em] text-muted">Add a location</h2>
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
          className="min-w-0 flex-1 rounded border border-line bg-ink px-2 py-1.5 text-sm text-text"
        />
        <button
          type="submit"
          disabled={busy || query.trim().length < 2}
          className="rounded bg-branch px-2 py-1.5 text-sm font-semibold text-onbranch disabled:bg-raised disabled:text-muted"
        >
          {busy ? '…' : 'Research'}
        </button>
      </form>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        A campus returns the 15–20 buildings that matter in an outage, and the lines that connect them.
      </p>
      {error && <p className="mt-2 text-sm leading-relaxed text-down">{error}</p>}
      {survey && (
        <div className="mt-2 rounded-md border border-line bg-ink p-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-text">{survey.name}</p>
            <button
              type="button"
              onClick={() => {
                setSurvey(null)
                onClear()
              }}
              className="text-sm font-semibold text-muted hover:text-text">
              Clear
            </button>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-text/80">{survey.summary}</p>
          {survey.power?.how_it_is_fed && (
            <p className="mt-1 text-sm leading-relaxed text-muted">
              <span className="text-text">Power.</span> {survey.power.how_it_is_fed}
            </p>
          )}
          {survey.placement && (
            <p className="mt-1 text-sm leading-relaxed text-muted">
              {survey.placement.checked
                ? `${survey.placement.on_map} placed from OpenStreetMap${survey.placement.from_model ? `, ${survey.placement.from_model} from the model's guess` : ''}${survey.placement.dropped?.length ? `, ${survey.placement.dropped.length} dropped as not found` : ''}. `
                : ''}
              <span className="text-warn">Assumed.</span> {survey.placement.note}
            </p>
          )}
          <p className="mt-2 text-sm font-semibold uppercase tracking-[0.14em] text-muted">
            {survey.buildings.length} buildings
          </p>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Click a building to take it offline. Losing a power source darkens what it feeds. A hospital rides through on its own generators.
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
                    className="w-full rounded px-1 py-0.5 text-left text-sm leading-relaxed text-muted hover:bg-raised"
                  >
                    <span className={down ? 'text-down' : 'text-text'}>{node.name}</span>
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
              <p className="mt-2 text-sm font-semibold uppercase tracking-[0.14em] text-muted">Core lines</p>
              <ul className="mt-1 flex flex-col gap-1">
                {survey.transit.map((line) => (
                  <li key={`${line.agency}-${line.name}`} className="text-sm leading-relaxed text-muted">
                    <span className="text-text">
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
                <li key={url} className="truncate text-xs text-branch">
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
