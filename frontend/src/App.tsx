import { useEffect, useMemo, useState } from 'react'
import { BranchPanel } from './components/BranchPanel'
import { GeoMap } from './components/GeoMap'
import { Inspector } from './components/Inspector'
import { LivePanel } from './components/LivePanel'
import { ScenarioStrip, type Scenario } from './components/ScenarioStrip'
import { Schematic } from './components/Schematic'
import { TopBar, type View } from './components/TopBar'
import type { Branch } from './lib/api'
import { isDisrupted, useSim, zoneLoads } from './lib/sim'
import { STATUS_COLOR } from './lib/status'
import { DEFAULT_STRATEGY } from './lib/strategies'

export default function App() {
  const sim = useSim()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<View>('grid')
  const [branching, setBranching] = useState(false)
  const [preview, setPreview] = useState<Branch | null>(null)
  const [scenario, setScenario] = useState<Scenario | null>(null)

  // While a policy is hovered in the branch list, the whole console shows its end state.
  const nodes = preview ? preview.nodes : sim.nodes
  const disrupted = isDisrupted(sim.nodes)
  const selected = useMemo(() => nodes.find((n) => n.id === selectedId), [nodes, selectedId])
  const zones = useMemo(() => zoneLoads(nodes), [nodes])
  const cooling = sim.briefing?.cooling
  const coolingIds = useMemo(() => (cooling?.open ? cooling.places.map((place) => place.id) : []), [cooling])

  const closeBranch = () => {
    setBranching(false)
    setPreview(null)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeBranch()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Break, Watch, Branch, Adopt. A policy other than the default means one was adopted.
  const step = !disrupted ? 0 : branching ? 2 : sim.strategy !== DEFAULT_STRATEGY ? 3 : 1
  const onStep = (index: number) => {
    if (index === 1) closeBranch()
    if (index >= 2 && disrupted) setBranching(true)
  }

  return (
    <div className="grid h-full min-h-[640px] grid-cols-[minmax(0,1fr)] grid-rows-[56px_minmax(0,1fr)] overflow-hidden bg-ink text-text">
      <TopBar sim={sim} nodes={nodes} step={step} onStep={onStep} view={view} onView={setView} />

      <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_340px] min-[1100px]:grid-cols-[minmax(0,1fr)_400px]">
        <main className="relative flex min-w-0 flex-col">
          <ScenarioStrip
            disrupted={disrupted}
            scenario={scenario}
            previewName={preview?.label ?? null}
            onScenario={setScenario}
            onChanged={sim.refresh}
          />

          <div className="relative min-h-0 flex-1 overflow-hidden">
            {sim.nodes.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted">
                <span>Waiting for the simulation engine…</span>
                <code className="font-mono text-xs">cd backend &amp;&amp; uvicorn main:app --port 8000</code>
              </div>
            ) : view === 'map' ? (
              <GeoMap
                nodes={nodes}
                edges={sim.edges}
                selectedId={selectedId}
                coolingIds={coolingIds}
                reroutes={sim.briefing?.buses.reroute ?? []}
                onNodeClick={(n) => setSelectedId(n.id === selectedId ? null : n.id)}
              />
            ) : (
              <Schematic
                nodes={nodes}
                edges={sim.edges}
                selectedId={selectedId}
                coolingIds={coolingIds}
                onNodeClick={(n) => setSelectedId(n.id === selectedId ? null : n.id)}
              />
            )}

            {selected && (
              <Inspector
                key={selected.id}
                node={selected}
                corner={view === 'map' ? 'top-right' : 'bottom-left'}
                onClose={() => setSelectedId(null)}
                onToggled={(node, failed) => {
                  if (failed && !scenario) setScenario({ label: 'Manual override', detail: `${node.name} failed` })
                  sim.refresh()
                }}
              />
            )}
          </div>

          <div className="grid shrink-0 grid-cols-4 border-t border-line bg-panel">
            {zones.map((z) => {
              const color = z.served >= 0.9 ? STATUS_COLOR.Green : z.served >= 0.5 ? STATUS_COLOR.Amber : STATUS_COLOR.Red
              return (
                <div key={z.zone} className="border-r border-line px-4 py-2.5">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{z.zone}</span>
                    <span className="font-mono text-[13px] tabular-nums" style={{ color }}>{Math.round(z.served * 100)}%</span>
                  </div>
                  <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-line">
                    <div className="h-full transition-[width] duration-500" style={{ width: `${z.served * 100}%`, background: color }} />
                  </div>
                  <div className="mt-1.5 text-[11px] text-muted">
                    {z.dark > 0 ? `${z.dark} building${z.dark > 1 ? 's' : ''} dark` : 'All buildings served'}
                  </div>
                </div>
              )
            })}
          </div>
        </main>

        <aside className="flex min-h-0 flex-col border-l border-line bg-panel">
          {branching ? (
            <BranchPanel
              onPreview={setPreview}
              onClose={closeBranch}
              onAdopted={() => {
                sim.refresh()
                closeBranch()
              }}
            />
          ) : (
            <LivePanel
              sim={sim}
              disrupted={disrupted}
              onBranch={() => setBranching(true)}
              onCommand={(result) => {
                if (result.policy.action === 'reset') setScenario(null)
                else if (result.policy.action === 'fail' && !scenario) setScenario({ label: 'Director’s order', detail: result.transcript })
                sim.refresh()
              }}
            />
          )}
        </aside>
      </div>
    </div>
  )
}
