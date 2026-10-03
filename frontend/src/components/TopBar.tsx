import { essentialServed, isSupplier, type Sim } from '../lib/sim'
import { STATUS_COLOR, fmtKw, fmtPct, type Status } from '../lib/status'

const SOURCE: Record<Sim['source'], { label: string; color: string; hint: string }> = {
  spacetimedb: { label: 'SpacetimeDB live', color: 'var(--color-ok)', hint: 'State arrives over a SpacetimeDB subscription.' },
  engine: { label: 'Engine direct', color: 'var(--color-warn)', hint: 'SpacetimeDB is unreachable. Reading state from the engine once a second.' },
  offline: { label: 'Offline', color: 'var(--color-down)', hint: 'Neither SpacetimeDB nor the simulation engine is reachable.' },
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="leading-tight">
      <div className="text-[10px] uppercase tracking-[0.12em] text-faint">{label}</div>
      <div className="font-mono text-sm tabular-nums" style={{ color }}>{value}</div>
    </div>
  )
}

interface Props {
  sim: Sim
  onBranch: () => void
}

export function TopBar({ sim, onBranch }: Props) {
  const { summary, nodes } = sim
  const ready = nodes.length > 0
  const essential = ready ? essentialServed(nodes) : 1
  const essentialColor = essential >= 0.999 ? STATUS_COLOR.Green : essential >= 0.8 ? STATUS_COLOR.Amber : STATUS_COLOR.Red
  const consumers = nodes.filter((n) => !isSupplier(n))
  const wanted = consumers.reduce((sum, n) => sum + n.demand, 0)
  const unserved = consumers.reduce((sum, n) => sum + Math.max(0, n.demand - n.currentPower), 0)
  const source = SOURCE[sim.source]
  const count = (s: Status) => nodes.filter((n) => n.status === s).length

  return (
    <header className="flex h-14 shrink-0 items-center gap-8 border-b border-line bg-panel px-5">
      <div className="flex items-center gap-3">
        <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden>
          <path d="M4 1 V21 M14 1 V8 C14 12 8 12 8 16 V21" fill="none" stroke="var(--color-branch)" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-[0.3em]">PARALLEL</div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-faint">Ann Arbor campus twin</div>
        </div>
      </div>

      <div className="flex items-center gap-7">
        <div className="leading-tight">
          <div className="text-[10px] uppercase tracking-[0.12em] text-faint">Essential demand served</div>
          <div className="font-mono text-xl font-medium tabular-nums" style={{ color: ready ? essentialColor : undefined }}>
            {ready ? fmtPct(essential) : '—'}
          </div>
        </div>
        <Stat label="Supply" value={summary ? fmtKw(summary.supply) : '—'} />
        <Stat label="Demand" value={ready ? fmtKw(wanted) : '—'} />
        <Stat label="Unserved" value={ready ? fmtKw(unserved) : '—'} color={unserved >= 1 ? STATUS_COLOR.Red : undefined} />
        <div className="flex items-center gap-3 border-l border-line pl-7 font-mono text-sm tabular-nums">
          {(['Green', 'Amber', 'Red'] as const).map((s) => (
            <span key={s} className="flex items-center gap-1.5" title={`${s} nodes`}>
              <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[s] }} />
              {ready ? count(s) : '—'}
            </span>
          ))}
        </div>
      </div>

      <div className="ml-auto flex items-center gap-5">
        <span className="flex items-center gap-2 text-xs text-muted" title={source.hint}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: source.color }} />
          {source.label}
          {summary && <span className="font-mono text-faint">t{summary.tick}</span>}
        </span>
        <button
          type="button"
          onClick={onBranch}
          disabled={!ready}
          className="flex items-center gap-2 rounded-md bg-branch px-3.5 py-2 text-sm font-semibold text-ink transition hover:brightness-110 disabled:opacity-40"
        >
          <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden>
            <path d="M2 1 V13 M10 1 V5 C10 8 5 7 5 10 V13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Branch timeline
        </button>
      </div>
    </header>
  )
}
