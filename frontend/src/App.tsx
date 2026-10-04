import { useEffect, useMemo, useRef, useState } from 'react'
import { BranchPanel } from './components/BranchPanel'
import { ClassLoad } from './components/ClassLoad'
import { CityCanvas } from './components/CityCanvas'
import { GeoMap, type GeoMapHandle, type WeatherStatus } from './components/GeoMap'
import { Inspector } from './components/Inspector'
import { LivePanel } from './components/LivePanel'
import { LocationPanel } from './components/LocationPanel'
import { PlanBuilding, type PlanDraft } from './components/PlanBuilding'
import { HEAT_WAVE, ScenarioStrip, runScenario, type Scenario } from './components/ScenarioStrip'
import { SaverPanel } from './components/SaverPanel'
import { Schematic } from './components/Schematic'
import { SurveyGraph } from './components/SurveyGraph'
import { TopBar, type View } from './components/TopBar'
import { fetchHazards, proposeBuilding, removeProposal, resetSim, type Branch, type Briefing, type LocationSurvey, type Hazard, type ProposalImpact } from './lib/api'
import { useClassLoad } from './lib/classLoad'
import { isDisrupted, loadTotals, useSim, zoneLoads } from './lib/sim'
import { STATUS_COLOR } from './lib/status'
import { DEFAULT_STRATEGY } from './lib/strategies'
import { buildSurvey, darkIds } from './lib/surveyGraph'
import type { StormNote } from './components/weather/useWeather'
import { endAbandoned } from './lib/weather/api'
import type { PlannedScenario } from './lib/weather/forecast'
import { STORM_HAZARD, type StormKind, type WeatherRequest, type WeatherState } from './lib/weather/types'

/** The strip's label. One from a finished run keeps its counts in step with the campus. */
type Label = Scenario & { run?: Required<Pick<StormNote, 'counts' | 'conditions'>> }

const RUNNING: Scenario = { label: 'Scenario running', detail: 'Reset stops it' }

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
  // Students in class by time of day. Lives here so it outlives the panel swap to branching.
  const classLoad = useClassLoad()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<View>('map')
  const [branching, setBranching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<Branch | null>(null)
  // The dock's plan when Branch opened. Each policy plays it forward on its own copy.
  const [branchPlan, setBranchPlan] = useState<PlannedScenario | null>(null)
  const [scenario, setScenario] = useState<Label | null>(null)
  const [hazard, setHazard] = useState<Hazard | null>(null)
  // Asks the scenario dock on the map to open. Each new seq is acted on once.
  const [weatherRequest, setWeatherRequest] = useState<WeatherRequest | null>(null)
  const [mapWeather, setMapWeather] = useState<WeatherStatus>({ active: false, running: false, hazards: [] })
  const weather = (sim.briefing as { weather?: WeatherState } | null)?.weather ?? null
  const mapRef = useRef<GeoMapHandle>(null)

  // The map stays mounted once shown, so a scenario keeps running behind the grid view.
  const [mapSeen, setMapSeen] = useState(view === 'map')
  if (view === 'map' && !mapSeen) setMapSeen(true)
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
  // Weather that only closes lines or roads leaves every building green, but there is still something to reset.
  const disrupted = isDisrupted(sim.nodes) || hasWeather(weather) || mapWeather.active || mapWeather.running
  // Once the campus is back to normal the last label no longer applies; the next disruption brings its own.
  const [wasDisrupted, setWasDisrupted] = useState(disrupted)
  if (wasDisrupted !== disrupted) {
    setWasDisrupted(disrupted)
    if (!disrupted && scenario) setScenario(null)
  }
  // Counted the way the zone bars count them: buildings with no power, failed or not, and no feeds.
  const darkCount = useMemo(() => zoneLoads(sim.nodes).reduce((sum, z) => sum + z.dark, 0), [sim.nodes])
  // A director's order or a manual override that lands mid-run must not replace the running label.
  const runningRef = useRef(mapWeather.running)
  useEffect(() => {
    runningRef.current = mapWeather.running
  })
  const offerLabel = (next: Scenario) => {
    if (!runningRef.current) setScenario((current) => current ?? next)
  }
  const selected = useMemo(() => nodes.find((n) => n.id === selectedId), [nodes, selectedId])
  const zones = useMemo(() => zoneLoads(nodes), [nodes])
  const totals = useMemo(() => loadTotals(nodes), [nodes])
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
  // With a plan in the dock, the comparison plays it forward, even mid-run. Without one it waits for the run to end.
  const openBranch = () => {
    const plan = mapRef.current?.plannedScenario() ?? null
    if (mapWeather.running && !plan) return
    setBranchPlan(plan)
    setBranching(true)
  }

  // FEMA hazards picked from the strip, by id, so a run that includes one can show its brief.
  const knownHazards = useRef(new Map<string, Hazard>())
  // Which FEMA hazard a drawn kind came from, e.g. winter storm rather than heavy snow for a blizzard.
  const pickedFor = useRef(new Map<StormKind, string>())
  const lastAsk = useRef<{ key: string; at: number } | null>(null)

  const requestWeather = (ask: Omit<WeatherRequest, 'seq'>, from: Hazard | null) => {
    setPlacing(null)
    setDraftPoint(null)
    setView('map')
    if (from) knownHazards.current.set(from.id, from)
    if (from && ask.kind) pickedFor.current.set(ask.kind, from.id)
    // A double or triple click on a condition or fault adds it once.
    const key = `${ask.kind ?? ''}|${ask.hazard ?? ''}|${ask.fault ?? ''}`
    const now = performance.now()
    const repeat = !ask.kind && lastAsk.current?.key === key && now - lastAsk.current.at < 700
    lastAsk.current = { key, at: now }
    if (repeat) return
    setWeatherRequest((current) => ({ ...ask, seq: (current?.seq ?? 0) + 1 }))
  }

  // The Briefing's hazard and the refuge label follow the run that just started, not a pill click:
  // its first condition, or weather drawn on the map, that FEMA has a brief for.
  const hazardAsk = useRef(0)
  const showRunHazard = (parts: readonly string[]) => {
    const first = parts[0]
    const drawn = first?.startsWith('storm:') ? (first.slice(6) as StormKind) : null
    const id = drawn ? (pickedFor.current.get(drawn) ?? STORM_HAZARD[drawn]) : first
    // Drawn weather does what was drawn, not the campus-wide effect FEMA's brief assumes.
    const asRun = (h: Hazard | undefined) => (h && drawn ? { ...h, effect: null } : (h ?? null))
    const ask = ++hazardAsk.current
    const known = id ? knownHazards.current.get(id) : undefined
    setHazard(asRun(known))
    if (!id || known) return
    fetchHazards()
      .then((list) => {
        const found = list?.hazards.find((h) => h.id === id)
        if (found) knownHazards.current.set(id, found)
        if (ask === hazardAsk.current) setHazard(asRun(found))
      })
      .catch(() => {})
  }

  const afterReset = () => {
    hazardAsk.current++
    setScenario(null)
    setHazard(null)
    sim.refresh()
  }

  // A reload part way through a run leaves its storms active on the engine. End them, once, before any run here starts.
  const refreshOnce = useRef(sim.refresh)
  useEffect(() => {
    void endAbandoned().then((ended) => {
      if (ended) refreshOnce.current()
    })
  }, [])

  useEffect(() => {
    const demo = new URLSearchParams(window.location.search).get('demo') === 'heat-wave'
    if (!demo || heatWaveStarted || sim.nodes.length === 0) return
    heatWaveStarted = true
    void (async () => {
      try {
        if (isDisrupted(sim.nodes) || hasWeather(weather)) await resetSim()
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
  const step = !disrupted && !branching ? 0 : branching ? 2 : sim.strategy !== DEFAULT_STRATEGY ? 3 : 1
  // Mid-run, Branch only opens to replay the plan: a plain fork taken then is out of date before it shows.
  const onStep = (index: number) => {
    if (index === 1) closeBranch()
    if (index >= 2 && (disrupted || mapWeather.planned)) openBranch()
  }

  return (
    <div className="grid h-full min-h-[640px] grid-cols-[minmax(0,1fr)] grid-rows-[56px_minmax(0,1fr)] overflow-hidden bg-ink text-text">
      <TopBar sim={sim} nodes={nodes} step={step} onStep={onStep} view={view} onView={setView} />

      <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_340px] min-[1100px]:grid-cols-[minmax(0,1fr)_400px]">
        <main className="relative flex min-w-0 flex-col">
          <ScenarioStrip
            disrupted={disrupted}
            scenario={mapWeather.running ? RUNNING : scenario ? shownLabel(scenario, darkCount, weather) : weatherNote(weather, darkCount)}
            previewName={preview?.label ?? null}
            onRequest={requestWeather}
            onResetting={() => mapRef.current?.clearWeather()}
            onReset={afterReset}
            saving={sim.saver !== null}
            onSaver={() => {
              closeBranch()
              setSaving(true)
            }}
          />

          {sim.briefing?.heat_wave && (
            <HeatWaveBanner wave={sim.briefing.heat_wave} />
          )}

          <div className="relative min-h-0 flex-1 overflow-hidden">
            {mapSeen && (
              // Opacity as well: MapLibre's attribution sets its own visibility.
              <div className={`absolute inset-0 ${view === 'map' ? '' : 'invisible opacity-0'}`} inert={view !== 'map'}>
                <GeoMap
                  ref={mapRef}
                  active={view === 'map'}
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
                  classSpots={classLoad.spots}
                  classClock={classLoad.clock}
                  onClassSlot={classLoad.setSlot}
                  onPlace={(lng, lat) => setDraftPoint({ lng, lat })}
                  weather={weather}
                  weatherRequest={weatherRequest}
                  onChanged={sim.refresh}
                  onWeatherStatus={(next) => {
                    // A run starts from the restored campus, so the last label, and any comparison forked before it, no longer apply.
                    if (next.running && !mapWeather.running) {
                      setScenario(null)
                      closeBranch()
                      showRunHazard(next.hazards)
                    }
                    setMapWeather(next)
                  }}
                  onStorm={(storm) =>
                    setScenario({
                      label: storm.label,
                      detail: storm.detail,
                      run: storm.counts && storm.conditions ? { counts: storm.counts, conditions: storm.conditions } : undefined,
                    })
                  }
                  onNodeClick={(n) => setSelectedId(n.id === selectedId ? null : n.id)}
                  onCampusChange={() => {
                    setSelectedId(null)
                    setPlacing(null)
                    setDraftPoint(null)
                  }}
                />
              </div>
            )}
            {view === 'city' &&
              (surveyModel ? (
                <SurveyGraph graph={surveyModel} dark={surveyDark} onToggle={toggleSurvey} />
              ) : (
                <CityCanvas
                  nodes={nodes}
                  edges={sim.edges}
                  selectedId={selectedId}
                  onNodeClick={(n) => setSelectedId(n.id === selectedId ? null : n.id)}
                />
              ))}
            {view === 'grid' &&
              (surveyModel ? (
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
              ))}
            {sim.nodes.length === 0 && (
              <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-ink text-sm text-muted">
                <span>Waiting for the simulation engine…</span>
                <code className="font-mono text-xs">cd backend &amp;&amp; uvicorn main:app --port 8000</code>
              </div>
            )}

            {selected && (
              <Inspector
                key={selected.id}
                node={selected}
                corner={view === 'map' ? 'top-right' : 'bottom-left'}
                onClose={() => setSelectedId(null)}
                onToggled={(node, failed) => {
                  if (failed) offerLabel({ label: 'Manual override', detail: `${node.name} failed` })
                  sim.refresh()
                }}
              />
            )}
          </div>

          <div className="grid shrink-0 grid-cols-[repeat(4,minmax(0,1fr))_auto] border-t border-line bg-panel">
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
            {/* A fourth row while the saver runs, packed tighter so the strip keeps its height. */}
            <dl className={`grid grid-cols-[auto_auto] content-center gap-x-3 whitespace-nowrap px-4 font-mono text-[11px] tabular-nums text-muted max-[1099px]:hidden ${sim.saver ? 'gap-y-0 py-1 leading-[15px]' : 'gap-y-0.5 py-2'}`}>
              <dt>supply</dt>
              <dd className="text-right text-text">{sim.summary ? `${Math.round(sim.summary.supply)} kW` : '—'}</dd>
              <dt>demand</dt>
              <dd className="text-right text-text">{Math.round(totals.demand)} kW</dd>
              <dt>unserved</dt>
              <dd className={`text-right ${totals.unserved >= 1 ? 'text-down' : 'text-text'}`}>{Math.round(totals.unserved)} kW</dd>
              {sim.saver && (
                <>
                  <dt>saved</dt>
                  <dd className="text-right text-text">{sim.saver.kwh_saved.toFixed(1)} kWh · −{Math.round(sim.saver.kw_saved_now)} kW now</dd>
                </>
              )}
            </dl>
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
              scenario={branchPlan}
              onAdoptAndRun={() => {
                sim.refresh()
                closeBranch()
                setView('map')
                mapRef.current?.runPlan()
              }}
            />
          ) : saving ? (
            <SaverPanel live={sim.saver} onClose={() => setSaving(false)} onChanged={sim.refresh} />
          ) : (
            <LivePanel
              sim={sim}
              disrupted={disrupted}
              running={mapWeather.running}
              planned={mapWeather.planned}
              hazard={hazard}
              demo={demo}
              onBranch={openBranch}
              onCommand={(result) => {
                if (result.policy.action === 'reset') {
                  mapRef.current?.clearWeather()
                  hazardAsk.current++
                  setScenario(null)
                  setHazard(null)
                }
                else if (result.policy.action === 'heat_wave') setScenario(HEAT_WAVE)
                else if (result.policy.action === 'fail') offerLabel({ label: 'Director’s order', detail: result.transcript })
                sim.refresh()
              }}
              people={<ClassLoad load={classLoad} />}
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
                      setView('city')
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

function hasWeather(weather: WeatherState | null): boolean {
  if (!weather) return false
  return weather.storms.length + weather.closed_routes.length + weather.cut_edges.length + weather.closed_roads.length > 0
}

const counted = (n: number, one: string, verb: string) => (n ? [`${n} ${one}${n > 1 ? 's' : ''} ${verb}`] : [])

/**
 * A finished run's label, with its counts as the campus has them now: dark buildings as the
 * zone bars count them, and lines, bus lines and roads as the engine has them closed. So a
 * building restored after the run comes off the strip too. Its conditions keep their own words.
 */
function shownLabel(label: Label, dark: number, weather: WeatherState | null): Scenario {
  const { run } = label
  if (!run) return label
  const { counts, conditions } = run
  const parts = [
    ...conditions,
    ...counted(dark, 'building', 'dark'),
    ...(conditions.length === 0 ? counted(counts.feeds, 'feed', 'derated') : []),
    ...counted(weather ? weather.cut_edges.length : counts.lines, 'line', 'down'),
    ...counted(weather ? new Set(weather.closed_routes.map((r) => r.id)).size : counts.buses, 'bus line', 'closed'),
    ...counted(weather ? weather.closed_roads.length : counts.roads, 'road', 'closed'),
  ]
  const text = parts.join(', ')
  return { label: label.label, detail: text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Nothing on campus was hit' }
}

/** A label for weather on record when this page did not start it, e.g. after a reload or a suspended line. */
function weatherNote(weather: WeatherState | null, dark: number): Scenario | null {
  if (!weather || !hasWeather(weather)) return null
  const lines = new Set(weather.closed_routes.map((route) => route.id)).size
  const detail = [
    ...counted(dark, 'building', 'dark'),
    ...counted(lines, 'bus line', 'out'),
    ...counted(weather.closed_roads.length, 'road', 'closed'),
    ...counted(weather.cut_edges.length, 'power line', 'cut'),
  ].join(', ')
  return { label: weather.storms.length ? 'Weather on record' : 'Director’s order', detail }
}
