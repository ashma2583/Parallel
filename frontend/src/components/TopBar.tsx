import { useState } from 'react'
import { useSpacetimeDB, useTable } from 'spacetimedb/react'
import { setClock } from '../lib/api'
import { tables } from '../module_bindings'
import { essentialServed, type Sim, type SimNode } from '../lib/sim'
import { STATUS_COLOR } from '../lib/status'

export type View = 'city' | 'grid' | 'map'

const STEPS = ['Break', 'Watch', 'Branch', 'Adopt'] as const

const SOURCE_HINT: Record<Sim['source'], string> = {
  spacetimedb: 'State arrives over a SpacetimeDB subscription.',
  engine: 'SpacetimeDB is unreachable. Reading state from the engine once a second.',
  offline: 'Neither SpacetimeDB nor the simulation engine is reachable.',
}

interface Props {
  sim: Sim
  /** Nodes on screen: the live campus, or the branch being previewed. */
  nodes: readonly SimNode[]
  /** 0 Break, 1 Watch, 2 Branch, 3 Adopt. */
  step: number
  onStep: (index: number) => void
  view: View
  onView: (view: View) => void
}

/** "Live · N directors": shown only while this window is connected to SpacetimeDB. */
function PresenceBadge() {
  const { isActive } = useSpacetimeDB()
  const [rows] = useTable(tables.presence)
  if (!isActive) return null
  const n = Math.max(1, rows.length)
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-line bg-ink px-2.5 py-1 text-xs font-medium"
      title="Directors connected to this campus right now"
      data-testid="presence-badge"
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_COLOR.Green }} />
      <span>{`Live · ${n} ${n === 1 ? 'director' : 'directors'}`}</span>
    </div>
  )
}

export function TopBar({ sim, nodes, step, onStep, view, onView }: Props) {
  const ready = nodes.length > 0
  const essential = ready ? essentialServed(nodes) : 1
  const essentialColor = essential >= 0.999 ? STATUS_COLOR.Green : essential >= 0.8 ? STATUS_COLOR.Amber : STATUS_COLOR.Red

  return (
    <header className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-6 overflow-hidden border-b border-line bg-panel px-5">
      <a href="/" className="flex shrink-0 items-center gap-3 whitespace-nowrap" aria-label="PARALLEL home">
        <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden>
          <path d="M4 1 V21 M14 1 V8 C14 12 8 12 8 16 V21" fill="none" stroke="var(--color-branch)" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-[0.3em]">PARALLEL</div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Ann Arbor campus twin</div>
        </div>
      </a>

      <ol className="flex w-full min-w-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap">
        {STEPS.map((label, i) => {
          const current = i === step
          const done = i < step
          return (
            <li key={label} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onStep(i)}
                aria-current={current ? 'step' : undefined}
                className={`flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] font-medium ${current ? 'bg-ink' : ''} ${current || done ? 'text-text' : 'text-muted'}`}
              >
                <span
                  className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border font-mono text-[10px] ${
                    done ? 'border-branch bg-branch text-onbranch' : current ? 'border-branch text-branch' : 'border-line text-muted'
                  }`}
                >
                  {i + 1}
                </span>
                <span className="max-[1099px]:hidden">{label}</span>
              </button>
              {i < STEPS.length - 1 && <span className="h-px w-5 bg-line" />}
            </li>
          )
        })}
      </ol>

      <div className="flex shrink-0 items-center gap-6 whitespace-nowrap">
        <PresenceBadge />
        <div className="flex items-baseline gap-2.5" title={SOURCE_HINT[sim.source]}>
          <span className="text-[10px] uppercase tracking-[0.12em] text-muted">Essential served</span>
          <span className="font-mono text-[22px] font-medium tabular-nums" style={{ color: ready ? essentialColor : undefined }}>
            {ready ? `${Math.round(essential * 100)}%` : '—'}
          </span>
        </div>
        <Clock tick={sim.summary?.tick} />
        <div className="flex whitespace-nowrap rounded-md border border-line bg-ink p-0.5 text-xs font-medium">
          {(['city', 'grid', 'map'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onView(v)}
              className={`rounded px-3 py-1 ${view === v ? 'bg-panel text-text' : 'text-muted'}`}
            >
              {v === 'city' ? 'City' : v === 'grid' ? 'Grid' : 'Ann Arbor'}
            </button>
          ))}
        </div>
      </div>
    </header>
  )
}

function Clock({ tick }: { tick: number | undefined }) {
  const [paused, setPaused] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function pause(next: boolean) {
    const clock = await setClock({ paused: next })
    setPaused(clock.paused)
    setError(null)
  }

  async function go() {
    const target = Number(draft)
    if (!Number.isFinite(target) || target < 1) return
    try {
      const clock = await setClock({ until: Math.round(target) })
      setPaused(clock.paused)
      setDraft('')
      setError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    }
  }

  return (
    <div className="flex items-center gap-1.5 font-mono text-xs" title={error ?? 'Pause, or jump to a saved tick'}>
      <button
        type="button"
        onClick={() => void pause(!paused)}
        className="rounded border border-line px-2 py-1 text-[11px] text-text"
      >
        {paused ? 'Play' : 'Pause'}
      </button>
      <span className="text-muted">t{tick ?? '—'}</span>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void go()
        }}
        placeholder="tick"
        aria-label="Jump to tick"
        className="w-12 rounded border border-line bg-ink px-1.5 py-1 text-text outline-none"
      />
      <button type="button" onClick={() => void go()} className="rounded px-1.5 py-1 text-[11px] font-semibold text-branch">
        Go
      </button>
    </div>
  )
}
