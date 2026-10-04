import { essentialServed, loadTotals, type Sim, type SimNode } from '../lib/sim'
import { STATUS_COLOR } from '../lib/status'

export type View = 'grid' | 'map'

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

export function TopBar({ sim, nodes, step, onStep, view, onView }: Props) {
  const ready = nodes.length > 0
  const essential = ready ? essentialServed(nodes) : 1
  const essentialColor = essential >= 0.999 ? STATUS_COLOR.Green : essential >= 0.8 ? STATUS_COLOR.Amber : STATUS_COLOR.Red
  const { demand, unserved } = loadTotals(nodes)

  return (
    <header className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-6 overflow-hidden border-b border-line bg-panel px-5">
      <a href="/" className="flex items-center gap-3" aria-label="PARALLEL home">
        <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden>
          <path d="M4 1 V21 M14 1 V8 C14 12 8 12 8 16 V21" fill="none" stroke="var(--color-branch)" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-[0.3em]">PARALLEL</div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-muted">Ann Arbor campus twin</div>
        </div>
      </a>

      <ol className="flex min-w-0 items-center gap-1 justify-self-center overflow-hidden whitespace-nowrap">
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
                <span className="max-[999px]:hidden">{label}</span>
              </button>
              {i < STEPS.length - 1 && <span className="h-px w-5 bg-line" />}
            </li>
          )
        })}
      </ol>

      <div className="flex items-center gap-6">
        <div className="flex items-baseline gap-2.5">
          <span className="text-[10px] uppercase tracking-[0.12em] text-muted">Essential served</span>
          <span className="font-mono text-[22px] font-medium tabular-nums" style={{ color: ready ? essentialColor : undefined }}>
            {ready ? `${Math.round(essential * 100)}%` : '—'}
          </span>
        </div>
        <div
          className="flex gap-4 whitespace-nowrap border-l border-line pl-6 font-mono text-xs tabular-nums text-muted max-[1099px]:hidden"
          title={SOURCE_HINT[sim.source]}
        >
          <span>supply <span className="text-text">{sim.summary ? `${Math.round(sim.summary.supply)} kW` : '—'}</span></span>
          <span>demand <span className="text-text">{ready ? `${Math.round(demand)} kW` : '—'}</span></span>
          <span>unserved <span className={unserved >= 1 ? 'text-down' : 'text-text'}>{ready ? `${Math.round(unserved)} kW` : '—'}</span></span>
          <span>{sim.summary ? `t${sim.summary.tick}` : 'offline'}</span>
        </div>
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
