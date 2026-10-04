import { useState } from 'react'
import { useSpacetimeDB, useTable } from 'spacetimedb/react'
import { setClock } from '../lib/api'
import { tables } from '../module_bindings'
import { essentialServed, type Sim, type SimNode } from '../lib/sim'
import { STATUS_COLOR } from '../lib/status'
import type { SimClock } from '../lib/simClock'

export type View = 'grid' | 'map'

const SOURCE_HINT: Record<Sim['source'], string> = {
  spacetimedb: 'State arrives over a SpacetimeDB subscription.',
  engine: 'SpacetimeDB is unreachable. Reading state from the engine once a second.',
  offline: 'Neither SpacetimeDB nor the simulation engine is reachable.',
}

interface Props {
  sim: Sim
  /** Nodes on screen: the live campus, or the branch being previewed. */
  nodes: readonly SimNode[]
  view: View
  onView: (view: View) => void
  /** The one time-of-day clock. */
  clock: SimClock
}

/** "N online": shown only while this window is connected to SpacetimeDB. */
function PresenceBadge() {
  const { isActive } = useSpacetimeDB()
  const [rows] = useTable(tables.presence)
  if (!isActive) return null
  const n = Math.max(1, rows.length)
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-line bg-ink px-2.5 py-1 text-xs font-medium"
      title="Shared live session (SpacetimeDB): everyone here sees the same campus"
      data-testid="presence-badge"
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_COLOR.Green }} />
      <span>{`${n} online`}</span>
    </div>
  )
}

export function TopBar({ sim, nodes, view, onView, clock }: Props) {
  const ready = nodes.length > 0
  const essential = ready ? essentialServed(nodes) : 1
  const essentialColor = essential >= 0.999 ? STATUS_COLOR.Green : essential >= 0.8 ? STATUS_COLOR.Amber : STATUS_COLOR.Red

  return (
    <header className="flex min-w-0 items-center justify-between gap-6 overflow-hidden border-b border-line bg-panel px-5">
      <a href="/" className="flex shrink-0 items-center gap-3 whitespace-nowrap" aria-label="PARALLEL home">
        <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden>
          <path d="M4 1 V21 M14 1 V8 C14 12 8 12 8 16 V21" fill="none" stroke="var(--color-branch)" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-[0.3em]">PARALLEL</div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Ann Arbor campus twin</div>
        </div>
      </a>

      <div className="flex min-w-0 shrink-0 items-center gap-6 whitespace-nowrap">
        <Clock clock={clock} />
        <div className="flex items-baseline gap-2.5" title={SOURCE_HINT[sim.source]}>
          <span className="text-[10px] uppercase tracking-[0.12em] text-muted">Essential served</span>
          <span className="font-mono text-[22px] font-medium tabular-nums" style={{ color: ready ? essentialColor : undefined }}>
            {ready ? `${Math.round(essential * 100)}%` : '—'}
          </span>
        </div>
        <PresenceBadge />
        <div className="flex whitespace-nowrap rounded-md border border-line bg-ink p-0.5 text-xs font-medium">
          {(['grid', 'map'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onView(v)}
              className={`rounded px-3 py-1 ${view === v ? 'bg-panel text-text' : 'text-muted'}`}
            >
              {v === 'grid' ? 'Grid' : 'Ann Arbor'}
            </button>
          ))}
        </div>
      </div>
    </header>
  )
}

function Clock({ clock }: { clock: SimClock }) {
  const [paused, setPaused] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function pause(next: boolean) {
    const state = await setClock({ paused: next })
    setPaused(state.paused)
    setError(null)
  }

  // Jump to a time of day: forward runs the engine there, back recalls a saved moment.
  async function go() {
    if (!draft.trim()) return
    const target = clock.tickFor(draft)
    if (target === null || target < 1) {
      setError('Type a time like 15:30.')
      return
    }
    try {
      const state = await setClock({ until: target })
      setPaused(state.paused)
      setDraft('')
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex items-center gap-1.5 font-mono text-xs" title={error ?? 'Time of day. A tick is 4 minutes. Pause, or jump to a time.'}>
      <button
        type="button"
        onClick={() => void pause(!paused)}
        className="rounded border border-line px-2 py-1 text-[11px] text-text"
      >
        {paused ? 'Play' : 'Pause'}
      </button>
      <span className="min-w-[3.25rem] text-center text-[15px] font-medium tabular-nums text-text" aria-label={`Time of day ${clock.label}`}>
        {clock.label}
      </span>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void go()
        }}
        placeholder="HH:MM"
        aria-label="Jump to a time of day"
        aria-invalid={error !== null}
        className={`w-14 rounded border bg-ink px-1.5 py-1 text-text outline-none ${error ? 'border-down' : 'border-line'}`}
      />
      <button type="button" onClick={() => void go()} className="rounded px-1.5 py-1 text-[11px] font-semibold text-branch">
        Go
      </button>
    </div>
  )
}
