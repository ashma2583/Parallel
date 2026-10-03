import { useMemo, useState } from 'react'
import { BranchView } from './components/BranchView'
import { DisruptRail } from './components/DisruptRail'
import { GeoMap } from './components/GeoMap'
import { OpsRail } from './components/OpsRail'
import { Schematic } from './components/Schematic'
import { TopBar } from './components/TopBar'
import { useSim, zoneLoads } from './lib/sim'
import { STATUS_COLOR, fmtPct } from './lib/status'

const VIEWS = [
  { id: 'grid', label: 'Grid' },
  { id: 'map', label: 'Ann Arbor' },
] as const

export default function App() {
  const sim = useSim()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = useMemo(() => sim.nodes.find((n) => n.id === selectedId), [sim.nodes, selectedId])
  const [view, setView] = useState<(typeof VIEWS)[number]['id']>('grid')
  const [branching, setBranching] = useState(false)
  const zones = useMemo(() => zoneLoads(sim.nodes), [sim.nodes])
  const cooling = sim.briefing?.cooling
  const coolingIds = useMemo(() => (cooling?.open ? cooling.places.map((place) => place.id) : []), [cooling])

  return (
    <div className="flex h-full flex-col">
      <TopBar sim={sim} onBranch={() => setBranching(true)} />

      <div className="relative flex min-h-0 flex-1">
        <DisruptRail sim={sim} />

        <main className="relative flex min-w-0 flex-1 flex-col">
          {sim.nodes.length > 0 ? (
            <>
              <div className="absolute left-4 top-4 z-10 flex rounded-md border border-line bg-panel p-0.5 text-xs font-medium">
                {VIEWS.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setView(v.id)}
                    className={`rounded px-3 py-1 transition ${view === v.id ? 'bg-raised text-text' : 'text-muted hover:text-text'}`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>

              <div className="min-h-0 flex-1">
                {view === 'map' ? (
                  <GeoMap
                    nodes={sim.nodes}
                    edges={sim.edges}
                    selectedId={selectedId}
                    coolingIds={coolingIds}
                    reroutes={sim.briefing?.buses.reroute ?? []}
                    onNodeClick={(n) => setSelectedId(n.id)}
                  />
                ) : (
                  <Schematic nodes={sim.nodes} edges={sim.edges} selectedId={selectedId} coolingIds={coolingIds} onNodeClick={(n) => setSelectedId(n.id)} />
                )}
              </div>

              <div className="grid shrink-0 grid-cols-4 border-t border-line bg-panel">
                {zones.map((z) => {
                  const color = z.served >= 0.9 ? STATUS_COLOR.Green : z.served >= 0.5 ? STATUS_COLOR.Amber : STATUS_COLOR.Red
                  return (
                    <div key={z.zone} className="border-r border-line px-4 py-2.5 last:border-r-0">
                      <div className="flex items-baseline justify-between">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{z.zone}</span>
                        <span className="font-mono text-[13px] tabular-nums" style={{ color }}>{fmtPct(z.served)}</span>
                      </div>
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-raised">
                        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${z.served * 100}%`, background: color }} />
                      </div>
                      <div className="mt-1.5 text-[11px] text-muted">
                        {z.dark > 0 ? `${z.dark} building${z.dark > 1 ? 's' : ''} dark` : 'All buildings served'}
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted">
              <span>Waiting for the simulation engine…</span>
              <code className="font-mono text-xs text-faint">cd backend &amp;&amp; uvicorn main:app --port 8000</code>
            </div>
          )}
        </main>

        <OpsRail sim={sim} selected={selected} />

        {branching && (
          <BranchView
            edges={sim.edges}
            onClose={() => setBranching(false)}
            onAdopted={() => {
              sim.refresh()
              setBranching(false)
            }}
          />
        )}
      </div>
    </div>
  )
}
