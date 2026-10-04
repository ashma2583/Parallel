import { useEffect, useMemo, useState } from 'react'
import { useSpacetimeDB, useTable } from 'spacetimedb/react'
import { tables } from './module_bindings'
import { CampusMap } from './components/CampusMap'
import { GeoMap } from './components/GeoMap'
import { SurveyGraph } from './components/SurveyGraph'
import { StatusBar } from './components/StatusBar'
import { ControlPanel } from './components/ControlPanel'
import {
  fetchActivity,
  fetchBriefing,
  fetchProposals,
  proposeBuilding,
  removeProposal,
  setPriority,
  type Briefing,
  type LocationSurvey,
  type PriorityMode,
  type ProposalImpact,
  type ProposalPin,
} from './lib/api'
import type { PlanDraft } from './components/PlanBuilding'
import { buildSurvey, darkIds } from './lib/surveyGraph'

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
  const [survey, setSurvey] = useState<LocationSurvey | null>(null)
  const [surveyFailed, setSurveyFailed] = useState<string[]>([])
  const [placing, setPlacing] = useState<PlanDraft | null>(null)
  const [draftPoint, setDraftPoint] = useState<{ lng: number; lat: number } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [proposals, setProposals] = useState<ProposalPin[]>([])
  const [proposalImpact, setProposalImpact] = useState<ProposalImpact | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const surveyModel = useMemo(() => (survey ? buildSurvey(survey) : null), [survey])
  const surveyDark = useMemo(() => (surveyModel ? darkIds(surveyModel, surveyFailed) : new Set<string>()), [surveyModel, surveyFailed])

  async function confirmPlacement() {
    if (!placing || !draftPoint || confirming) return
    setConfirming(true)
    setPlanError(null)
    try {
      const impact = await proposeBuilding({ ...placing, lng: draftPoint.lng, lat: draftPoint.lat })
      setProposalImpact(impact)
      setProposals(await fetchProposals())
      setPlacing(null)
      setDraftPoint(null)
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err))
    } finally {
      setConfirming(false)
    }
  }

  async function dropProposal(id: string) {
    await removeProposal(id)
    setProposals(await fetchProposals())
    setProposalImpact((current) => (current?.id === id ? null : current))
  }

  function toggleSurvey(id: string) {
    setSurveyFailed((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }
  const coolingIds = briefing?.cooling.open ? briefing.cooling.places.map((place) => place.id) : []

  async function onPriority(mode: PriorityMode) {
    const next = await setPriority(mode)
    setBriefing(next)
  }

  useEffect(() => {
    let stop = false
    const pull = async () => {
      try {
        const [lines, nextBriefing, nextProposals] = await Promise.all([fetchActivity(), fetchBriefing(), fetchProposals()])
        if (stop) return
        setActivity(lines)
        setBriefing(nextBriefing)
        setProposals(nextProposals)
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
                survey={survey}
                surveyGraph={surveyModel}
                surveyDark={surveyDark}
                onToggleSurvey={toggleSurvey}
                placing={placing !== null}
                proposals={proposals}
                draftPoint={draftPoint ? { ...draftPoint, name: placing?.name ?? 'Planned' } : null}
                onPlace={(lng, lat) => setDraftPoint({ lng, lat })}
                onNodeClick={(n) => setSelectedId(n.id)}
              />
            ) : surveyModel ? (
              <SurveyGraph graph={surveyModel} dark={surveyDark} onToggle={toggleSurvey} />
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
          onSurvey={(next) => {
            setSurvey(next)
            setSurveyFailed([])
            setView('map')
          }}
          onClearSurvey={() => {
            setSurvey(null)
            setSurveyFailed([])
            setView('graph')
          }}
          placing={placing !== null}
          pinReady={draftPoint !== null}
          confirming={confirming}
          proposalImpact={proposalImpact}
          proposals={proposals}
          onStartPlan={(draft) => {
            setPlanError(null)
            setDraftPoint(null)
            setPlacing(draft)
            setView('map')
          }}
          onMovePlan={() => setDraftPoint(null)}
          onConfirmPlan={() => void confirmPlacement()}
          onCancelPlan={() => {
            setPlacing(null)
            setDraftPoint(null)
          }}
          onRemoveProposal={(id) => void dropProposal(id)}
          planError={planError}
          surveyGraph={surveyModel}
          surveyDark={surveyDark}
          onToggleSurvey={toggleSurvey}
        />
      </div>
    </div>
  )
}
