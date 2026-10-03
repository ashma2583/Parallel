import { useEffect, useMemo, useState } from 'react'
import { useSpacetimeDB, useTable } from 'spacetimedb/react'
import { tables } from './module_bindings'
import { CampusMap } from './components/CampusMap'
import { GeoMap } from './components/GeoMap'
import { StatusBar } from './components/StatusBar'
import { ControlPanel } from './components/ControlPanel'
import { fetchActivity, fetchBriefing, setPriority, type Briefing, type PriorityMode } from './lib/api'

export default function App() {
  const { isActive, connectionError } = useSpacetimeDB()

  // Live subscriptions. SpacetimeDB pushes row diffs; React re-renders.
  const [nodes, nodesReady] = useTable(tables.node)
  const [edges] = useTable(tables.edge)
  const [simRows] = useTable(tables.simState)
  const sim = simRows[0]

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = useMemo(() => nodes.find((n) => n.id === selectedId), [nodes, selectedId])
  const [activity, setActivity] = useState<string[]>([])
  const [briefing, setBriefing] = useState<Briefing | null>(null)
  const [view, setView] = useState<'graph' | 'map'>('graph')
  const coolingIds = briefing?.cooling.open ? briefing.cooling.places.map((place) => place.id) : []

  async function onPriority(mode: PriorityMode) {
    const next = await setPriority(mode)
    setBriefing(next)
  }

  useEffect(() => {
    let stop = false
    const pull = async () => {
      try {
        const [lines, nextBriefing] = await Promise.all([fetchActivity(), fetchBriefing()])
        if (stop) return
        setActivity(lines)
        setBriefing(nextBriefing)
      } catch {
        // The map still updates from SpacetimeDB if the REST poll misses a beat.
      }
    }
    void pull()
    const timer = setInterval(() => void pull(), 1000)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [])

  const sortedNodes = useMemo(() => [...nodes].sort((a, b) => a.id.localeCompare(b.id)), [nodes])

  return (
    <div className="flex h-full flex-col">
      <StatusBar sim={sim} connected={isActive} connectionError={connectionError} />

      <div className="flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1">
          <div className="absolute left-3 top-3 z-10 flex overflow-hidden rounded-md border border-slate-700 bg-slate-950/90 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setView('graph')}
              className={`px-3 py-1.5 ${view === 'graph' ? 'bg-slate-100 text-slate-950' : 'text-slate-300'}`}
            >
              Grid
            </button>
            <button
              type="button"
              onClick={() => setView('map')}
              className={`px-3 py-1.5 ${view === 'map' ? 'bg-slate-100 text-slate-950' : 'text-slate-300'}`}
            >
              Ann Arbor
            </button>
          </div>
          {nodesReady && nodes.length > 0 ? (
            view === 'map' ? (
              <GeoMap
                nodes={sortedNodes}
                edges={edges}
                coolingIds={coolingIds}
                reroutes={briefing?.buses.reroute ?? []}
                onNodeClick={(n) => setSelectedId(n.id)}
              />
            ) : (
              <CampusMap nodes={sortedNodes} edges={edges} coolingIds={coolingIds} onNodeClick={(n) => setSelectedId(n.id)} />
            )
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              {isActive
                ? 'Connected. Waiting for the simulation engine to publish state…'
                : connectionError
                  ? `Cannot reach SpacetimeDB: ${connectionError.message}`
                  : 'Connecting to SpacetimeDB…'}
            </div>
          )}
        </main>

        <ControlPanel
          nodes={sortedNodes}
          selected={selected}
          activity={activity}
          briefing={briefing}
          onPriority={(mode) => void onPriority(mode)}
        />
      </div>
    </div>
  )
}
