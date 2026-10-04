import { useEffect, useMemo, useState } from 'react'
import { BranchPanel } from './components/BranchPanel'
import { GeoMap } from './components/GeoMap'
import { Inspector } from './components/Inspector'
import { LivePanel } from './components/LivePanel'
import { LocationPanel } from './components/LocationPanel'
import { PlanBuilding, type PlanDraft } from './components/PlanBuilding'
import { HEAT_WAVE, ScenarioStrip, runScenario, type Scenario } from './components/ScenarioStrip'
import { Schematic } from './components/Schematic'
import { SurveyGraph } from './components/SurveyGraph'
import { TopBar, type View } from './components/TopBar'
import { proposeBuilding, removeProposal, resetSim, type Branch, type Briefing, type LocationSurvey, type ProposalImpact } from './lib/api'
import { isDisrupted, useSim, zoneLoads } from './lib/sim'
import { STATUS_COLOR } from './lib/status'
import { DEFAULT_STRATEGY } from './lib/strategies'
import { buildSurvey, darkIds } from './lib/surveyGraph'

// Survives React's strict-mode remount so the heat wave is not applied twice.
let heatWaveStarted = false

function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} min`
  if (rest === 0) return `${hours} hr`
  return `${hours} hr ${rest} min`
}

function HeatWaveBanner({ wave }: { wave: Briefing['heat_wave'] }) {
  const building = wave && wave.step > 0 && wave.step < wave.span
  const plant = wave ? Math.round(wave.plant * 100) : 100
  const line = !wave || wave.step === 0
    ? 'The heat wave is just starting. Plant output falls over the next 4 hours. You can keep the dorms or the classrooms. The hospital stays on.'
    : building
      ? `Heat has been building for ${formatMinutes(wave.minutes)} of ${formatMinutes(wave.total_minutes)}. Central plant at ${plant}%, still falling toward 35%. You can keep the dorms or the classrooms. The hospital stays on.`
      : 'Central plant at 35%. You can keep the dorms or the classrooms. The hospital stays on.'
  return (
    <div className="border-b border-line bg-ink px-4 py-2.5">
      <p className="text-base font-medium">{line}</p>
      <p className="mt-1 text-sm text-muted">The three intakes, these buildings, and the U-M bus lines are real. The kilowatts are a scaled model. One tick is 4 minutes of the afternoon.</p>
    </div>
  )
}

export default function App() {
  const sim = useSim()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<View>('grid')
  const [branching, setBranching] = useState(false)
  const [preview, setPreview] = useState<Branch | null>(null)
  const [scenario, setScenario] = useState<Scenario | null>(null)
  const [demo] = useState(() => new URLSearchParams(window.location.search).get('demo') === 'heat-wave')

  // A researched place, shown in place of the campus until it is cleared.
  const [survey, setSurvey] = useState<LocationSurvey | null>(null)
  const [surveyFailed, setSurveyFailed] = useState<string[]>([])
  const surveyModel = useMemo(() => (survey ? buildSurvey(survey) : null), [survey])
  const surveyDark = useMemo(() => (surveyModel ? darkIds(surveyModel, surveyFailed) : new Set<string>()), [surveyModel, surveyFailed])
  const toggleSurvey = (id: string) =>
    setSurveyFailed((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))

  // A planned building: fill the form, drop a pin on the map, confirm.
  const [placing, setPlacing] = useState<PlanDraft | null>(null)
  const [draftPoint, setDraftPoint] = useState<{ lng: number; lat: number } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [proposalImpact, setProposalImpact] = useState<ProposalImpact | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)

  async function confirmPlacement() {
    if (!placing || !draftPoint || confirming) return
    setConfirming(true)
    setPlanError(null)
    try {
      setProposalImpact(await proposeBuilding({ ...placing, lng: draftPoint.lng, lat: draftPoint.lat }))
      setPlacing(null)
      setDraftPoint(null)
      sim.refresh()
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err))
    } finally {
      setConfirming(false)
    }
  }

  async function dropProposal(id: string) {
    await removeProposal(id)
    setProposalImpact((current) => (current?.id === id ? null : current))
    sim.refresh()
  }

  // While a policy is hovered in the branch list, the whole console shows its end state.
  const nodes = preview ? preview.nodes : sim.nodes
  const disrupted = isDisrupted(sim.nodes)
  const selected = useMemo(() => nodes.find((n) => n.id === selectedId), [nodes, selectedId])
  const zones = useMemo(() => zoneLoads(nodes), [nodes])
  const shelter = sim.briefing?.shelter ?? sim.briefing?.cooling
  const shelterKind = shelter?.kind ?? (sim.briefing?.season === 'summer' ? 'cooling' : 'warming')
  const coolingIds = useMemo(() => (shelter?.open ? shelter.places.map((place) => place.id) : []), [shelter])
  const useRouteIds = useMemo(
    () => (sim.briefing?.buses.reroute ?? []).filter((route) => route.keep.length > 0).map((route) => route.id),
    [sim.briefing],
  )

  const closeBranch = () => {
    setBranching(false)
    setPreview(null)
  }

  useEffect(() => {
    const demo = new URLSearchParams(window.location.search).get('demo') === 'heat-wave'
    if (!demo || heatWaveStarted || sim.nodes.length === 0) return
    heatWaveStarted = true
    void (async () => {
      try {
        if (isDisrupted(sim.nodes)) await resetSim()
        await runScenario(HEAT_WAVE)
        setScenario(HEAT_WAVE)
        sim.refresh()
      } catch {
        heatWaveStarted = false
      }
    })()
  }, [sim.nodes.length, sim.refresh])

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

          {scenario?.label === HEAT_WAVE.label && (
            <HeatWaveBanner wave={sim.briefing?.heat_wave} />
          )}

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
                shelterKind={shelterKind}
                useRouteIds={useRouteIds}
                reroutes={sim.briefing?.buses.reroute ?? []}
                survey={survey}
                surveyGraph={surveyModel}
                surveyDark={surveyDark}
                onToggleSurvey={toggleSurvey}
                placing={placing !== null}
                proposals={sim.proposals}
                draftPoint={draftPoint ? { ...draftPoint, name: placing?.name ?? 'Planned' } : null}
                onPlace={(lng, lat) => setDraftPoint({ lng, lat })}
                onNodeClick={(n) => setSelectedId(n.id === selectedId ? null : n.id)}
              />
            ) : surveyModel ? (
              <SurveyGraph graph={surveyModel} dark={surveyDark} onToggle={toggleSurvey} />
            ) : (
              <Schematic
                nodes={nodes}
                edges={sim.edges}
                selectedId={selectedId}
                coolingIds={coolingIds}
                shelterKind={shelterKind}
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

        <aside className={`flex min-h-0 flex-col border-l border-line bg-panel ${demo ? 'demo-rail' : ''}`}>
          {branching ? (
            <BranchPanel
              demo={demo}
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
              demo={demo}
              onBranch={() => setBranching(true)}
              onCommand={(result) => {
                if (result.policy.action === 'reset') setScenario(null)
                else if (result.policy.action === 'heat_wave') setScenario(HEAT_WAVE)
                else if (result.policy.action === 'fail' && !scenario) setScenario({ label: 'Director’s order', detail: result.transcript })
                sim.refresh()
              }}
              plan={
                <>
                  <PlanBuilding
                    placing={placing !== null}
                    pinReady={draftPoint !== null}
                    confirming={confirming}
                    impact={proposalImpact}
                    pins={sim.proposals}
                    onStart={(draft) => {
                      setPlanError(null)
                      setDraftPoint(null)
                      setPlacing(draft)
                      setView('map')
                    }}
                    onUndo={() => setDraftPoint(null)}
                    onConfirm={() => void confirmPlacement()}
                    onCancel={() => {
                      setPlacing(null)
                      setDraftPoint(null)
                    }}
                    onRemove={(id) => void dropProposal(id)}
                    error={planError}
                  />
                  <LocationPanel
                    onShow={(next) => {
                      setSurvey(next)
                      setSurveyFailed([])
                      setView('map')
                    }}
                    onClear={() => {
                      setSurvey(null)
                      setSurveyFailed([])
                      setView('grid')
                    }}
                    graph={surveyModel}
                    dark={surveyDark}
                    onToggle={toggleSurvey}
                  />
                </>
              }
            />
          )}
        </aside>
      </div>
    </div>
  )
}
