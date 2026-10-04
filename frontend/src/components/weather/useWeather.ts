/**
 * Controller for the scenario composer. The director stacks weather drawn on
 * the map, campus-wide conditions and equipment faults into one plan, edits
 * it, then runs it. A run puts the campus back the way it was before the first
 * run of this plan, then plays every event on one clock and sends each hit to
 * the engine as it lands. An engine without weather routes still gets the hits
 * through /disrupt; the storms and their closures then live here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Map as MaplibreMap } from 'maplibre-gl'
import { applyHazard, disrupt, resetSim, type ProposalPin } from '../../lib/api'
import { PLACES } from '../../lib/places'
import type { SimEdge, SimNode } from '../../lib/sim'
import {
  asWeather,
  clearScenario,
  downIn,
  endStorm,
  fetchDown,
  fetchStorms,
  hitStorm,
  NoStormRoutes,
  restoreRoute,
  runScenario,
  startStorm,
  suspendRoute,
  type StormHit,
} from '../../lib/weather/api'
import { bearing, compass, dist, distPointPath, pathLength, runDuration, simplify } from '../../lib/weather/geo'
import { buildWorld, computeImpacts, countImpacts, stormLabel } from '../../lib/weather/impacts'
import {
  eventLabel,
  faultEvent,
  HAZARD_MS,
  hazardEvent,
  loadPlan,
  nextStart,
  parseClock,
  patchEvent,
  planNames,
  planTotal,
  radiusOf,
  savePlan,
  sortEvents,
  stagedOf,
  stormEvent,
  translatePath,
  type StormEvent,
} from '../../lib/weather/plan'
import {
  EMPTY_WEATHER,
  FAULT_SPECS,
  HAZARD_SPECS,
  STORM_SPECS,
  type BusLine,
  type CampusEffect,
  type ClosedRoute,
  type DockPhase,
  type DockPreview,
  type DraftStorm,
  type EdgeMark,
  type EventPatch,
  type FaultKind,
  type HazardKind,
  type HoverStorm,
  type Impact,
  type LiveStorm,
  type LngLat,
  type MapMark,
  type ScenarioEvent,
  type ScenarioPlan,
  type Storm,
  type StormKind,
  type StormRecord,
  type WeatherCanvasProps,
  type WeatherDockProps,
  type WeatherRequest,
  type WeatherState,
} from '../../lib/weather/types'

export interface WeatherOptions {
  map: MaplibreMap | null
  nodes: readonly SimNode[]
  edges: readonly SimEdge[]
  proposals: readonly ProposalPin[]
  /** U-M bus shapes, both directions. */
  buses: readonly BusLine[]
  /** briefing.weather. Missing on an engine without weather routes. */
  server: WeatherState | null | undefined
  /** Open the dock, and arm a kind or add a condition or fault, whenever seq changes. */
  request?: WeatherRequest | null
  /** Older way to open the dock: whenever this changes to a new value above zero. */
  openSignal?: number
  /** Pull engine state now. Called after every engine write. */
  onChanged: () => void
  /** A run finished. */
  onStorm?: (s: { label: string; detail: string }) => void
}

/** The dock's props, plus the clock time the scenario starts at. */
export interface ComposerDockProps extends WeatherDockProps {
  /** "HH:MM". */
  startsAt: string
  onStartsAt: (value: string) => void
}

export interface WeatherController {
  /** A kind is armed: map clicks and drags draw a storm instead of panning. */
  armed: boolean
  effective: WeatherState
  canvas: Omit<WeatherCanvasProps, 'map'>
  dock: ComposerDockProps
  /** Suspend a whole U-M line, or restore it if the director suspended it. */
  toggleRoute: (id: string, name: string) => void
  /** Forget weather kept in the browser, e.g. right after a campus reset. */
  clear: () => void
}

const DEFAULT_LEVEL: Record<StormKind, number> = {
  tornado: 2,
  thunderstorm: 1,
  ice: 1,
  flood: 1,
  blizzard: 1,
  lightning: 1,
  blackout: 0,
  closure: 1,
}

/** Short line for the ticker when a condition arrives. */
const HAZARD_SHORT: Record<HazardKind, string> = {
  heat: 'both feeds at 70%',
  cold: 'power plant at 60%',
  wind: 'North Campus feed at 50%',
}

/** Screen distances in CSS pixels. */
const SAMPLE_PX = 6
const CLICK_PX = 8
const MAX_POINTS = 80
const PREVIEW_MS = 120
/** Hits landing this close together go to the engine as one write. */
const BATCH_MS = 120
/** Trust a write's reply over the polled briefing for this long. */
const HOLD_MS = 1500

const CITY = new Set(['city_hall', 'blake', 'fire_1'])
const CAMPUS: LngLat = [-83.728, 42.284]
const NONE: ReadonlySet<string> = new Set()

/** Requests already acted on. Lives outside the hook so a remounted map does not replay one. */
let handledRequest: number | undefined

interface Press {
  id: number
  box: HTMLElement
  x: number
  y: number
  lastX: number
  lastY: number
  /** Farthest the pointer got from the press point, px. */
  moved: number
  at: LngLat
  path: LngLat[]
}

/** One run of the plan. Every timer and engine write checks its token before acting. */
interface Run {
  token: number
  events: ScenarioEvent[]
  speed: number
  /** Storms started in this run. */
  stormIds: Set<string>
  /** Nodes down right now in this run: the restored campus plus every hit so far. Impacts are scored against it. */
  down: Set<string>
  /** Planned buildings for this run. Null means the current ones; empty after a plain reset cleared them. */
  proposals: readonly ProposalPin[] | null
  /** Everything that has landed, oldest first. */
  landed: Impact[]
}

type RunState = 'none' | 'running' | 'done'

export function useWeather(o: WeatherOptions): WeatherController {
  const { map, server, openSignal, request } = o

  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<StormKind | null>(null)
  const [levels, setLevels] = useState(DEFAULT_LEVEL)
  const [draftPath, setDraftPath] = useState<LngLat[] | null>(null)
  const [hoverAt, setHoverAt] = useState<LngLat | null>(null)
  const [preview, setPreview] = useState<DockPreview | null>(null)
  const [plan, setPlan] = useState<ScenarioPlan>(loadPlan)
  const [version, setVersion] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [runState, setRunState] = useState<RunState>('none')
  const [ranVersion, setRanVersion] = useState<number | null>(null)
  const [clock, setClock] = useState<WeatherDockProps['run']>(null)
  const [started, setStarted] = useState<ReadonlySet<string>>(NONE)
  const [live, setLive] = useState<LiveStorm[]>([])
  const [campus, setCampus] = useState<CampusEffect[]>([])
  const [landed, setLanded] = useState<Impact[]>([])
  const [last, setLast] = useState<WeatherDockProps['last']>(null)
  const [local, setLocal] = useState<WeatherState>(EMPTY_WEATHER)
  const [remote, setRemote] = useState<WeatherState | null>(null)
  const [fresh, setFresh] = useState(false)
  const [retired, setRetired] = useState<ReadonlySet<string>>(NONE)
  const [degraded, setDegraded] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [error, setError] = useState<string | null>(null)

  const level = kind ? levels[kind] : 0
  const running = runState === 'running'
  const armed = open && kind !== null && !running
  const phase: DockPhase = running ? 'running' : draftPath ? 'drawing' : armed ? 'armed' : runState === 'done' ? 'done' : 'idle'

  const [signal, setSignal] = useState<number | undefined>(0)
  if (openSignal !== signal) {
    setSignal(openSignal)
    if (openSignal && openSignal > 0) setOpen(true)
  }

  // Something outside the map asked for the dock: arm a kind, or add a condition or fault.
  const [seenRequest, setSeenRequest] = useState(() => handledRequest)
  if (request && request.seq !== seenRequest) {
    setSeenRequest(request.seq)
    setOpen(true)
    if (request.kind) setKind(request.kind)
    const extra = request.hazard ?? request.fault
    if (extra) {
      const start = nextStart(plan.events)
      const event = request.hazard ? hazardEvent(request.hazard, start) : faultEvent(request.fault as FaultKind, start)
      setPlan({ ...plan, events: sortEvents([...plan.events, event]) })
      setVersion((v) => v + 1)
      setSelectedId(event.id)
    }
  }

  const optsRef = useRef(o)
  const planRef = useRef(plan)
  const versionRef = useRef(version)
  const selectedRef = useRef(selectedId)
  const levelsRef = useRef(levels)
  const speedRef = useRef(speed)
  const armRef = useRef({ kind, level })
  /** The armed kind, set the moment the dock picks it rather than after the next render. */
  const kindRef = useRef(kind)
  const pressRef = useRef<Press | null>(null)
  const hoverRef = useRef<LngLat | null>(null)
  const timers = useRef(new Set<number>())
  const previewTimer = useRef(0)
  const previewCost = useRef(0)
  const thinned = useRef<{ from: readonly BusLine[]; to: BusLine[] } | null>(null)
  const freshTimer = useRef(0)
  const hintTimer = useRef(0)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const degradedRef = useRef(false)
  const confirmed = useRef(new Set<string>())
  const retiredRef = useRef(retired)
  const misses = useRef(0)
  const dirty = useRef(false)
  const liveRef = useRef<LiveStorm[]>([])
  const tokenRef = useRef(0)
  const runRef = useRef<Run | null>(null)
  const runningRef = useRef(false)

  useEffect(() => {
    optsRef.current = o
  })
  // Kept in step with state changed during render, e.g. by a request from outside the map.
  useEffect(() => {
    planRef.current = plan
  }, [plan])
  useEffect(() => {
    kindRef.current = kind
  }, [kind])
  useEffect(() => {
    selectedRef.current = selectedId
  }, [selectedId])
  useEffect(() => {
    handledRequest = seenRequest
  }, [seenRequest])
  useEffect(() => {
    armRef.current = { kind, level }
  }, [kind, level])
  useEffect(() => {
    levelsRef.current = levels
  }, [levels])
  useEffect(() => {
    speedRef.current = speed
  }, [speed])
  useEffect(() => {
    versionRef.current = version
  }, [version])
  useEffect(() => {
    savePlan(plan)
  }, [plan])

  // ---- small plumbing ------------------------------------------------------

  const notify = useCallback(() => optsRef.current.onChanged(), [])

  const fail = useCallback((err: unknown) => setError(message(err)), [])

  const hint = useCallback((text: string, ms = 2600) => {
    setError(text)
    window.clearTimeout(hintTimer.current)
    hintTimer.current = window.setTimeout(() => setError((now) => (now === text ? null : now)), ms)
  }, [])

  const markDegraded = useCallback((value: boolean) => {
    degradedRef.current = value
    setDegraded(value)
  }, [])

  /** Keep a write's reply on screen until the briefing has caught up with it. */
  const accept = useCallback((weather: WeatherState) => {
    setRemote(weather)
    setFresh(true)
    window.clearTimeout(freshTimer.current)
    freshTimer.current = window.setTimeout(() => setFresh(false), HOLD_MS)
  }, [])

  /** Engine writes go out one at a time, in order. */
  const enqueue = useCallback(
    (job: () => Promise<void>) => {
      queue.current = queue.current.then(job).catch(fail)
    },
    [fail],
  )

  const later = useCallback((ms: number, fn: () => void) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id)
      fn()
    }, ms)
    timers.current.add(id)
  }, [])

  const clearRun = useCallback(() => {
    for (const id of timers.current) window.clearTimeout(id)
    timers.current.clear()
  }, [])

  useEffect(() => {
    const runs = timers.current
    const tokens = tokenRef
    return () => {
      for (const id of runs) window.clearTimeout(id)
      runs.clear()
      // Anything still queued from a run belongs to a map that is gone.
      tokens.current++
      window.clearTimeout(previewTimer.current)
      window.clearTimeout(freshTimer.current)
      window.clearTimeout(hintTimer.current)
    }
  }, [])

  // Find out early whether the engine has weather routes, so the dock can say so.
  useEffect(() => {
    let stop = false
    fetchStorms()
      .then((weather) => {
        if (stop) return
        setRemote(weather)
        markDegraded(false)
      })
      .catch((err) => {
        if (!stop && err instanceof NoStormRoutes) markDegraded(true)
      })
    return () => {
      stop = true
    }
  }, [markDegraded])

  // ---- the plan ------------------------------------------------------------

  /** Replace the plan's events, kept in start order, and mark the plan edited. */
  const commit = useCallback((events: ScenarioEvent[], startsAt?: string) => {
    const next: ScenarioPlan = { events: sortEvents(events), startsAt: startsAt ?? planRef.current.startsAt }
    planRef.current = next
    setPlan(next)
    setVersion((v) => v + 1)
  }, [])

  const select = useCallback((id: string | null) => {
    selectedRef.current = id
    setSelectedId(id)
  }, [])

  const add = useCallback(
    (make: (start: number) => ScenarioEvent) => {
      const event = make(nextStart(planRef.current.events))
      commit([...planRef.current.events, event])
      select(event.id)
      return event
    },
    [commit, select],
  )

  const onUpdate = useCallback(
    (id: string, patch: EventPatch) => {
      const events = planRef.current.events
      const at = events.findIndex((e) => e.id === id)
      if (at < 0) return
      const { event, hint: why } = patchEvent(events[at], patch, (k) => levelsRef.current[k])
      if (why) hint(why)
      if (event === events[at]) return
      const next = [...events]
      next[at] = event
      commit(next)
    },
    [commit, hint],
  )

  const onRemove = useCallback(
    (id: string) => {
      const events = planRef.current.events
      if (!events.some((e) => e.id === id)) return
      commit(events.filter((e) => e.id !== id))
      if (selectedRef.current === id) select(null)
    },
    [commit, select],
  )

  const onAddHazard = useCallback(
    (hazard: HazardKind) => {
      add((start) => hazardEvent(hazard, start))
      setOpen(true)
    },
    [add],
  )

  const onAddFault = useCallback(
    (fault: FaultKind) => {
      add((start) => faultEvent(fault, start))
      setOpen(true)
    },
    [add],
  )

  const onStartsAt = useCallback(
    (value: string) => {
      const parsed = parseClock(value)
      if (!parsed) return
      const next = `${String(parsed[0]).padStart(2, '0')}:${String(parsed[1]).padStart(2, '0')}`
      if (next !== planRef.current.startsAt) commit(planRef.current.events, next)
    },
    [commit],
  )

  const movePath = useCallback(
    (id: string, path: LngLat[]) => {
      commit(planRef.current.events.map((e) => (e.id === id && e.type === 'storm' ? { ...e, path } : e)))
    },
    [commit],
  )

  // ---- preview -------------------------------------------------------------

  const computePreview = useCallback(() => {
    const { kind, level } = armRef.current
    if (!kind) {
      setPreview(null)
      return
    }
    const spec = STORM_SPECS[kind]
    const press = pressRef.current
    let path: LngLat[] | null = null
    if (press) {
      if (press.path.length > 1 && spec.input !== 'point') path = fitPath(press.path)
      else if (spec.input !== 'path') path = [press.at]
    } else if (hoverRef.current && spec.input !== 'path') {
      path = [hoverRef.current]
    }
    if (!path) {
      setPreview(null)
      return
    }
    const started = performance.now()
    const p = optsRef.current
    const radius = radiusOf(kind, level)
    // A wide footprint does not need every vertex of every bus shape to count the lines it closes.
    let buses = p.buses
    if (radius >= 120) {
      if (thinned.current?.from !== p.buses) thinned.current = { from: p.buses, to: thin(p.buses, 60) }
      buses = thinned.current.to
    }
    const storm: Storm = { id: 'preview', kind, level, path, radius, label: '' }
    const impacts = computeImpacts(storm, buildWorld(p.nodes, p.edges, p.proposals, buses))
    const moving = path.length > 1
    previewCost.current = performance.now() - started
    setPreview({
      lengthKm: moving ? pathLength(path) / 1000 : 0,
      heading: moving ? compass(bearing(path[0], path[path.length - 1])) : null,
      counts: countImpacts(impacts),
      impacts,
    })
  }, [])

  const schedulePreview = useCallback(() => {
    if (previewTimer.current) return
    // Back off when the campus is slow to score, so drawing stays smooth.
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = 0
      computePreview()
    }, Math.max(PREVIEW_MS, previewCost.current * 3))
  }, [computePreview])

  const stopPreview = useCallback(() => {
    window.clearTimeout(previewTimer.current)
    previewTimer.current = 0
    setPreview(null)
  }, [])

  useEffect(() => {
    if (armed) schedulePreview()
  }, [armed, kind, level, schedulePreview])

  // ---- the run -------------------------------------------------------------

  /** Send one batch of hits. Falls back to /disrupt when the engine has no weather routes. */
  const send = useCallback(
    async (storm: Storm, hit: StormHit) => {
      if (!degradedRef.current) {
        try {
          const weather = await hitStorm(hit)
          // Null: the engine dropped this storm when a newer run put the campus back.
          if (weather) {
            accept(weather)
            notify()
          }
          return
        } catch (err) {
          if (err instanceof NoStormRoutes) markDegraded(true)
          else fail(err)
        }
      }
      if (await viaDisrupt(hit, storm.label)) notify()
    },
    [accept, fail, markDegraded, notify],
  )

  /** Something arrived: on the ticker, and into what later storms see as down. */
  const land = useCallback((run: Run, impact: Impact) => {
    run.landed.push(impact)
    if (impact.action === 'fail' || impact.action === 'cut') for (const id of impact.nodeIds) run.down.add(id)
    setLanded((prev) => [...prev, impact])
  }, [])

  const endLater = useCallback(
    (storm: Storm, summary: string) => {
      setLocal((prev) => ({ ...prev, storms: [...prev.storms.filter((s) => s.id !== storm.id), { ...storm, status: 'done' }] }))
      enqueue(async () => {
        if (degradedRef.current) return
        try {
          const weather = await endStorm(storm.id, summary)
          if (weather) accept(weather)
          notify()
        } catch (err) {
          if (err instanceof NoStormRoutes) markDegraded(true)
          else fail(err)
        }
      })
    },
    [accept, enqueue, fail, markDegraded, notify],
  )

  const playStorm = useCallback(
    (run: Run, event: StormEvent, index: number) => {
      const spec = STORM_SPECS[event.kind]
      const p = optsRef.current
      const storm: Storm = {
        id: `storm-${Date.now().toString(36)}-${index}`,
        kind: event.kind,
        level: event.level,
        path: event.path,
        radius: radiusOf(event.kind, event.level),
        label: stormLabel(event.kind, event.level),
      }
      // Scored against the campus as this run has it right now, so a re-run plays out the same.
      const world = buildWorld(withDown(p.nodes, run.down), p.edges, run.proposals ?? p.proposals, p.buses)
      const impacts = computeImpacts(storm, world)
      const duration = runDuration(event.kind, event.path, spec.msPerKm) / run.speed
      const names = new Map(p.nodes.map((node) => [node.id, PLACES[node.id]?.short ?? node.name]))
      const nameOf = (id: string) => names.get(id) ?? id
      const item: LiveStorm = { storm, impacts, startedAt: performance.now(), duration }
      const current = () => run.token === tokenRef.current

      run.stormIds.add(storm.id)
      liveRef.current = [...liveRef.current, item]
      setLive(liveRef.current)

      enqueue(async () => {
        if (!current()) return
        try {
          accept(await startStorm({ ...storm, headline: headline(storm) }))
          markDegraded(false)
          notify()
        } catch (err) {
          if (err instanceof NoStormRoutes || err instanceof TypeError) markDegraded(true)
          else fail(err)
        }
      })

      for (const impact of impacts) {
        later(impact.t * duration, () => {
          if (!current()) return
          land(run, impact)
          setLocal((prev) => addHit(prev, storm.id, impact))
        })
      }
      for (const batch of batches(impacts, duration)) {
        const at = batch[batch.length - 1].t * duration
        later(at, () => {
          if (!current()) return
          const hit = toHit(storm, batch, nameOf)
          enqueue(async () => {
            if (current()) await send(storm, hit)
          })
        })
      }

      later(duration + 80, () => {
        if (!current()) return
        liveRef.current = liveRef.current.filter((l) => l.storm.id !== storm.id)
        setLive(liveRef.current)
        endLater(storm, summarize(storm, impacts).line)
      })
    },
    [accept, endLater, enqueue, fail, land, later, markDegraded, notify, send],
  )

  const playHazard = useCallback(
    (run: Run, event: ScenarioEvent & { type: 'hazard' }) => {
      const spec = HAZARD_SPECS[event.hazard]
      setCampus((prev) => [
        ...prev,
        { id: `${event.id}:${run.token}`, hazard: event.hazard, startedAt: performance.now(), duration: HAZARD_MS / run.speed },
      ])
      land(run, {
        key: `hazard:${event.id}`,
        t: 0,
        target: 'feed',
        action: 'derate',
        at: CAMPUS,
        label: `${spec.label} arrived`,
        detail: HAZARD_SHORT[event.hazard],
        nodeIds: [],
      })
      enqueue(async () => {
        if (run.token !== tokenRef.current) return
        const reply = await applyHazard(spec.hazardId)
        // Some conditions fail a feed outright; later storms should see it down.
        for (const id of downIn(reply) ?? []) run.down.add(id)
        notify()
      })
    },
    [enqueue, land, notify],
  )

  const playFault = useCallback(
    (run: Run, event: ScenarioEvent & { type: 'fault' }) => {
      const spec = FAULT_SPECS[event.fault]
      const place = PLACES[spec.nodeIds[0]]
      land(run, {
        key: `fault:${event.id}`,
        t: 0,
        target: 'feed',
        action: 'fail',
        at: place ? [place.lng, place.lat] : CAMPUS,
        label: spec.label,
        detail: spec.detail.charAt(0).toLowerCase() + spec.detail.slice(1),
        nodeIds: [...spec.nodeIds],
      })
      enqueue(async () => {
        if (run.token !== tokenRef.current) return
        await disrupt([...spec.nodeIds], 'fail', spec.reason)
        notify()
      })
    },
    [enqueue, land, notify],
  )

  const finish = useCallback((run: Run) => {
    runningRef.current = false
    liveRef.current = []
    setLive([])
    setClock(null)
    setRunState('done')
    const single = run.events.length === 1
    const label = single ? eventLabel(run.events[0]) : 'Scenario'
    setLast({ label, counts: countImpacts(run.landed) })
    optsRef.current.onStorm?.({ label: single ? label : `Scenario: ${planNames(run.events)}`, detail: describe(run.landed) })
  }, [])

  /** Play every event on one clock, from now. */
  const begin = useCallback(
    (run: Run) => {
      const total = planTotal(run.events, run.speed)
      setClock({ startedAt: performance.now(), total })
      run.events.forEach((event, index) => {
        later((event.start * 1000) / run.speed, () => {
          if (run.token !== tokenRef.current) return
          setStarted((prev) => new Set(prev).add(event.id))
          if (event.type === 'storm') playStorm(run, event, index)
          else if (event.type === 'hazard') playHazard(run, event)
          else playFault(run, event)
        })
      })
      later(total + 120, () => {
        if (run.token === tokenRef.current) finish(run)
      })
    },
    [finish, later, playFault, playHazard, playStorm],
  )

  const cancelDraw = useCallback(() => {
    const press = pressRef.current
    if (press) {
      try {
        press.box.releasePointerCapture(press.id)
      } catch {
        // The pointer was already released.
      }
    }
    pressRef.current = null
    stopPreview()
    setDraftPath(null)
  }, [stopPreview])

  const onRun = useCallback(() => {
    if (runningRef.current) return
    const events = planRef.current.events
    if (events.length === 0) {
      hint('Add something to the plan first')
      return
    }
    if (pressRef.current) cancelDraw()
    kindRef.current = null
    setKind(null)
    hoverRef.current = null
    setHoverAt(null)
    stopPreview()

    clearRun()
    const token = ++tokenRef.current
    const run: Run = { token, events: [...events], speed: speedRef.current, stormIds: new Set(), down: new Set(), proposals: null, landed: [] }
    runRef.current = run
    runningRef.current = true
    dirty.current = false

    // The engine clears weather from earlier runs. Stop counting on it, so it is not read as a reset.
    const gone = new Set(retiredRef.current)
    for (const s of local.storms) gone.add(s.id)
    for (const s of (remote ?? EMPTY_WEATHER).storms) gone.add(s.id)
    for (const s of (server ? asWeather(server) : EMPTY_WEATHER).storms) gone.add(s.id)
    for (const id of confirmed.current) gone.add(id)
    retiredRef.current = gone
    setRetired(gone)
    confirmed.current.clear()
    misses.current = 0

    liveRef.current = []
    setLive([])
    setCampus([])
    setLanded([])
    setLast(null)
    setError(null)
    setStarted(NONE)
    setClock(null)
    setLocal(EMPTY_WEATHER)
    setRemote(null)
    setFresh(false)
    setRunState('running')
    setRanVersion(versionRef.current)

    const current = () => token === tokenRef.current
    enqueue(async () => {
      if (!current()) return
      let wiped = false
      try {
        const reply = await runScenario()
        accept(reply.weather)
      } catch (err) {
        if (err instanceof NoStormRoutes) {
          // An engine without scenario routes cannot put the campus back. Start from a clean one instead.
          try {
            await resetSim()
            wiped = true
            hint('Campus reset; planned buildings cleared', 6000)
          } catch (reset) {
            fail(reset)
          }
        } else {
          fail(err)
        }
      }
      if (!current()) return
      notify()
      const down = await fetchDown()
      if (!current()) return
      run.down = down ?? (wiped ? new Set() : new Set(optsRef.current.nodes.filter((n) => n.failed).map((n) => n.id)))
      run.proposals = wiped ? [] : null
      begin(run)
    })
  }, [accept, begin, cancelDraw, clearRun, enqueue, fail, hint, local, notify, remote, server, stopPreview])

  const onStop = useCallback(() => {
    const run = runRef.current
    if (!run || !runningRef.current) return
    tokenRef.current++
    clearRun()
    runningRef.current = false
    const stopping = liveRef.current
    liveRef.current = []
    setLive([])
    setClock(null)
    setRunState('done')
    for (const item of stopping) endLater(item.storm, `${item.storm.label} stopped`)
    const single = run.events.length === 1
    setLast({ label: single ? eventLabel(run.events[0]) : 'Scenario', counts: countImpacts(run.landed) })
  }, [clearRun, endLater])

  const onClear = useCallback(() => {
    if (runningRef.current) onStop()
    commit([])
    select(null)
    setCampus([])
    setLanded([])
    setLast(null)
    setRunState('none')
    setRanVersion(null)
    clearScenario().catch((err) => {
      if (!(err instanceof NoStormRoutes) && !(err instanceof TypeError)) fail(err)
    })
  }, [commit, fail, onStop, select])

  // ---- drawing -------------------------------------------------------------

  const release = useCallback(
    (press: Press, end: LngLat) => {
      const { kind, level } = armRef.current
      stopPreview()
      setDraftPath(null)
      if (!kind) return
      const spec = STORM_SPECS[kind]
      const stage = (path: LngLat[]) => add((start) => stormEvent(kind, level, path, start))
      if (press.moved < CLICK_PX) {
        if (spec.input === 'path') {
          hint('Drag to draw its path')
          return
        }
        stage([press.at])
        return
      }
      if (spec.input === 'point') {
        stage([press.at])
        return
      }
      const raw = [...press.path]
      if (dist(raw[raw.length - 1], end) > 0.5) raw.push(end)
      stage(fitPath(raw))
    },
    [add, hint, stopPreview],
  )

  useEffect(() => {
    if (!map || !armed) return
    const box = map.getCanvasContainer()
    const was = {
      dragPan: map.dragPan.isEnabled(),
      dragRotate: map.dragRotate.isEnabled(),
      boxZoom: map.boxZoom.isEnabled(),
      doubleClickZoom: map.doubleClickZoom.isEnabled(),
      cursor: box.style.cursor,
      touchAction: box.style.touchAction,
    }
    map.dragPan.disable()
    map.dragRotate.disable()
    map.boxZoom.disable()
    map.doubleClickZoom.disable()
    box.style.cursor = 'crosshair'
    box.style.touchAction = 'none'

    const screen = (e: PointerEvent): [number, number] => {
      const r = box.getBoundingClientRect()
      return [e.clientX - r.left, e.clientY - r.top]
    }
    const toLngLat = (xy: [number, number]): LngLat => {
      const ll = map.unproject(xy)
      return [ll.lng, ll.lat]
    }
    let frame = 0
    let pending: [number, number] | null = null

    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !e.isPrimary || pressRef.current || !armRef.current.kind) return
      e.preventDefault()
      e.stopPropagation()
      const [x, y] = screen(e)
      const at = toLngLat([x, y])
      try {
        box.setPointerCapture(e.pointerId)
      } catch {
        // Synthetic or already-gone pointer; drawing still works without capture.
      }
      pressRef.current = { id: e.pointerId, box, x, y, lastX: x, lastY: y, moved: 0, at, path: [at] }
      hoverRef.current = null
      pending = null
      setHoverAt(null)
      setError(null)
      setDraftPath([at])
      schedulePreview()
    }
    const move = (e: PointerEvent) => {
      const press = pressRef.current
      const [x, y] = screen(e)
      if (press) {
        if (e.pointerId !== press.id) return
        press.moved = Math.max(press.moved, Math.hypot(x - press.x, y - press.y))
        if (Math.hypot(x - press.lastX, y - press.lastY) < SAMPLE_PX) return
        press.lastX = x
        press.lastY = y
        press.path.push(toLngLat([x, y]))
        setDraftPath([...press.path])
        schedulePreview()
        return
      }
      if (!e.isPrimary) return
      pending = [x, y]
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (!pending || pressRef.current) return
        const at = toLngLat(pending)
        hoverRef.current = at
        setHoverAt(at)
        schedulePreview()
      })
    }
    const up = (e: PointerEvent) => {
      const press = pressRef.current
      if (!press || e.pointerId !== press.id) return
      const [x, y] = screen(e)
      press.moved = Math.max(press.moved, Math.hypot(x - press.x, y - press.y))
      try {
        box.releasePointerCapture(e.pointerId)
      } catch {
        // Already released.
      }
      pressRef.current = null
      release(press, toLngLat([x, y]))
    }
    const cancel = (e: PointerEvent) => {
      if (pressRef.current && e.pointerId === pressRef.current.id) cancelDraw()
    }
    const leave = (e: PointerEvent) => {
      const press = pressRef.current
      if (press) {
        if (e.pointerId === press.id && !box.hasPointerCapture(press.id)) cancelDraw()
        return
      }
      pending = null
      hoverRef.current = null
      setHoverAt(null)
      stopPreview()
    }
    // A click that drops a storm must not also select a building or place a proposal.
    const swallow = (e: MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
    }

    box.addEventListener('pointerdown', down, true)
    box.addEventListener('pointermove', move)
    box.addEventListener('pointerup', up)
    box.addEventListener('pointercancel', cancel)
    box.addEventListener('pointerleave', leave)
    box.addEventListener('click', swallow, true)
    box.addEventListener('dblclick', swallow, true)
    return () => {
      box.removeEventListener('pointerdown', down, true)
      box.removeEventListener('pointermove', move)
      box.removeEventListener('pointerup', up)
      box.removeEventListener('pointercancel', cancel)
      box.removeEventListener('pointerleave', leave)
      box.removeEventListener('click', swallow, true)
      box.removeEventListener('dblclick', swallow, true)
      if (frame) cancelAnimationFrame(frame)
      const press = pressRef.current
      if (press) {
        try {
          box.releasePointerCapture(press.id)
        } catch {
          // Already released.
        }
        pressRef.current = null
      }
      setDraftPath(null)
      box.style.cursor = was.cursor
      box.style.touchAction = was.touchAction
      try {
        if (was.dragPan) map.dragPan.enable()
        if (was.dragRotate) map.dragRotate.enable()
        if (was.boxZoom) map.boxZoom.enable()
        if (was.doubleClickZoom) map.doubleClickZoom.enable()
      } catch {
        // The map was removed first.
      }
    }
  }, [map, armed, cancelDraw, release, schedulePreview, stopPreview])

  // ---- picking and moving planned storms -----------------------------------

  // With nothing armed, a press inside a planned storm selects it and a drag moves it.
  // Presses anywhere else are left to the map, and a plain click there clears the selection.
  const picking = open && !armed && !running
  useEffect(() => {
    if (!map || !picking) return
    const box = map.getCanvasContainer()
    const surface = map.getCanvas()
    const base = box.style.cursor
    let cursor: string | null = null
    const setCursor = (next: string | null) => {
      if (next === cursor) return
      cursor = next
      box.style.cursor = next ?? base
    }
    const screen = (e: PointerEvent): [number, number] => {
      const r = box.getBoundingClientRect()
      return [e.clientX - r.left, e.clientY - r.top]
    }
    const toLngLat = (xy: [number, number]): LngLat => {
      const ll = map.unproject(xy)
      return [ll.lng, ll.lat]
    }
    /** The topmost planned storm under a point: the last one in the plan wins. */
    const hit = (at: LngLat): StormEvent | null => {
      const events = planRef.current.events
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e.type === 'storm' && distPointPath(at, e.path) <= radiusOf(e.kind, e.level)) return e
      }
      return null
    }

    let drag: { id: string; pointer: number; x: number; y: number; at: LngLat; path: LngLat[]; moved: number; dragPan: boolean } | null = null
    let blank: { pointer: number; x: number; y: number } | null = null
    let swallowClick = false
    let frame = 0
    let pending: { xy: [number, number]; onSurface: boolean } | null = null

    const endDrag = () => {
      if (!drag) return
      try {
        box.releasePointerCapture(drag.pointer)
      } catch {
        // Already released.
      }
      try {
        if (drag.dragPan) map.dragPan.enable()
      } catch {
        // The map was removed first.
      }
      drag = null
    }

    const down = (e: PointerEvent) => {
      swallowClick = false
      if (e.button !== 0 || !e.isPrimary || drag) return
      // Building markers and other overlays keep their own clicks.
      if (e.target !== surface) return
      const [x, y] = screen(e)
      const at = toLngLat([x, y])
      const target = hit(at)
      if (!target) {
        blank = { pointer: e.pointerId, x, y }
        return
      }
      e.preventDefault()
      e.stopPropagation()
      select(target.id)
      const dragPan = map.dragPan.isEnabled()
      if (dragPan) map.dragPan.disable()
      try {
        box.setPointerCapture(e.pointerId)
      } catch {
        // Synthetic pointer; the drag still works while it stays over the map.
      }
      drag = { id: target.id, pointer: e.pointerId, x, y, at, path: target.path, moved: 0, dragPan }
      setCursor('grabbing')
    }
    const move = (e: PointerEvent) => {
      const [x, y] = screen(e)
      if (drag) {
        if (e.pointerId !== drag.pointer) return
        drag.moved = Math.max(drag.moved, Math.hypot(x - drag.x, y - drag.y))
        if (drag.moved < CLICK_PX) return
        const now = toLngLat([x, y])
        movePath(drag.id, translatePath(drag.path, now[0] - drag.at[0], now[1] - drag.at[1]))
        return
      }
      // While the map is being panned, leave its cursor alone.
      if (!e.isPrimary || e.buttons !== 0) return
      pending = { xy: [x, y], onSurface: e.target === surface }
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (!pending || drag) return
        const target = pending.onSurface ? hit(toLngLat(pending.xy)) : null
        setCursor(target ? (target.id === selectedRef.current ? 'grab' : 'pointer') : null)
      })
    }
    const up = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.pointer) {
        endDrag()
        // The click that follows must not reach the map as a building pick or a proposal.
        swallowClick = true
        setCursor('grab')
        return
      }
      if (blank && e.pointerId === blank.pointer) {
        const [x, y] = screen(e)
        if (Math.hypot(x - blank.x, y - blank.y) < CLICK_PX && selectedRef.current) select(null)
        blank = null
      }
    }
    const cancel = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.pointer) {
        endDrag()
        setCursor(null)
      }
      blank = null
    }
    const leave = () => {
      if (!drag) setCursor(null)
    }
    const click = (e: MouseEvent) => {
      if (!swallowClick) return
      swallowClick = false
      e.stopPropagation()
      e.preventDefault()
    }

    box.addEventListener('pointerdown', down, true)
    box.addEventListener('pointermove', move)
    box.addEventListener('pointerup', up)
    box.addEventListener('pointercancel', cancel)
    box.addEventListener('pointerleave', leave)
    box.addEventListener('click', click, true)
    return () => {
      box.removeEventListener('pointerdown', down, true)
      box.removeEventListener('pointermove', move)
      box.removeEventListener('pointerup', up)
      box.removeEventListener('pointercancel', cancel)
      box.removeEventListener('pointerleave', leave)
      box.removeEventListener('click', click, true)
      if (frame) cancelAnimationFrame(frame)
      endDrag()
      box.style.cursor = base
    }
  }, [map, picking, movePath, select])

  // ---- dock controls -------------------------------------------------------

  const onKind = useCallback(
    (next: StormKind | null) => {
      if (pressRef.current) cancelDraw()
      kindRef.current = next
      setKind(next)
      setError(null)
      if (next) {
        setOpen(true)
      } else {
        hoverRef.current = null
        setHoverAt(null)
        stopPreview()
      }
    },
    [cancelDraw, stopPreview],
  )

  const onLevel = useCallback((value: number) => {
    const kind = kindRef.current
    if (!kind) return
    const top = STORM_SPECS[kind].levels.length - 1
    setLevels((prev) => ({ ...prev, [kind]: Math.max(0, Math.min(top, Math.round(value))) }))
  }, [])

  const onOpen = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (next) return
      if (pressRef.current) cancelDraw()
      kindRef.current = null
      setKind(null)
      select(null)
      hoverRef.current = null
      setHoverAt(null)
      stopPreview()
    },
    [cancelDraw, select, stopPreview],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The dock already handled it, e.g. Delete on a focused plan row.
      if (e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (target && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable)) return
      if (e.key === 'Escape') {
        if (pressRef.current) {
          e.preventDefault()
          cancelDraw()
        } else if (kindRef.current && !runningRef.current) {
          e.preventDefault()
          onKind(null)
        } else if (selectedRef.current) {
          e.preventDefault()
          select(null)
        }
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const id = selectedRef.current
        if (!id || pressRef.current) return
        e.preventDefault()
        onRemove(id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancelDraw, onKind, onRemove, select])

  // ---- what the map shows --------------------------------------------------

  const base = useMemo(() => (server ? asWeather(server) : null), [server])

  const effective = useMemo(() => {
    const root = fresh || !base ? (remote ?? base ?? EMPTY_WEATHER) : base
    const active: WeatherState = live.length > 0 ? { ...EMPTY_WEATHER, storms: live.map((l) => ({ ...l.storm, status: 'active' as const })) } : EMPTY_WEATHER
    return without(merge(root, local, active), retired)
  }, [base, fresh, remote, local, live, retired])

  const effectiveRef = useRef(effective)
  useEffect(() => {
    effectiveRef.current = effective
  }, [effective])

  /** Drop weather kept in the browser for these storms, or all of it. A run they belong to stops. */
  const forget = useCallback(
    (ids: Set<string> | null) => {
      const keep = (stormId: string | null | undefined) => ids !== null && !(stormId && ids.has(stormId))
      setLocal((prev) => ({
        storms: prev.storms.filter((s) => keep(s.id)),
        closed_routes: prev.closed_routes.filter((r) => (ids === null ? false : r.storm_id ? keep(r.storm_id) : true)),
        cut_edges: prev.cut_edges.filter((e) => keep(e.storm_id)),
        closed_roads: prev.closed_roads.filter((e) => keep(e.storm_id)),
      }))
      const run = runRef.current
      const cancel = runningRef.current && run !== null && (ids === null || [...ids].some((id) => run.stormIds.has(id)))
      if (cancel) {
        tokenRef.current++
        clearRun()
        runningRef.current = false
        liveRef.current = []
        setLive([])
        setClock(null)
      }
      setCampus([])
      setLanded([])
      setLast(null)
      setRemote(null)
      setFresh(false)
      setRunState((now) => (now === 'done' || (cancel && now === 'running') ? 'none' : now))
    },
    [clearRun],
  )

  const clear = useCallback(() => {
    confirmed.current.clear()
    misses.current = 0
    forget(null)
  }, [forget])

  // The engine forgot a storm it had confirmed: it was reset. A run is only
  // stopped when two polls in a row agree, so one late reply cannot end it.
  useEffect(() => {
    if (!base) return
    if (degradedRef.current) markDegraded(false)
    const ids = new Set(base.storms.map((s) => s.id).filter((id) => !retiredRef.current.has(id)))
    const gone = [...confirmed.current].some((id) => !ids.has(id))
    misses.current = gone ? misses.current + 1 : 0
    const run = runRef.current
    const hold = runningRef.current && run !== null && [...confirmed.current].some((id) => run.stormIds.has(id)) && misses.current < 2
    if (gone && !hold) {
      const dropped = new Set(confirmed.current)
      confirmed.current.clear()
      misses.current = 0
      forget(dropped)
    }
    for (const id of ids) confirmed.current.add(id)
  }, [base, forget, markDegraded])

  // Without weather routes, a campus that goes from damaged back to all green
  // with nothing running has been reset.
  const nodes = o.nodes
  useEffect(() => {
    if (nodes.length === 0) return
    const clean = nodes.every((node) => !node.failed && node.status === 'Green')
    if (!clean) {
      dirty.current = true
      return
    }
    if (runningRef.current) return
    if (dirty.current && degraded) forget(null)
    dirty.current = false
  }, [nodes, degraded, forget])

  const toggleRoute = useCallback(
    (id: string, name: string) => {
      const isSuspension = (r: ClosedRoute) => r.id === id && r.segments === null
      const suspended = effectiveRef.current.closed_routes.some(isSuspension)
      const here = () =>
        setLocal((prev) => ({
          ...prev,
          closed_routes: suspended
            ? prev.closed_routes.filter((r) => !isSuspension(r))
            : [...prev.closed_routes, { id, name, segments: null, reason: 'suspended by the director', storm_id: null }],
        }))
      if (degradedRef.current) {
        here()
        return
      }
      const write = suspended ? restoreRoute(id) : suspendRoute(id, name)
      write
        .then((weather) => {
          if (suspended) here()
          accept(weather)
          notify()
        })
        .catch((err) => {
          if (err instanceof NoStormRoutes || err instanceof TypeError) {
            markDegraded(true)
            here()
          } else {
            fail(err)
          }
        })
    },
    [accept, fail, markDegraded, notify],
  )

  // ---- props ---------------------------------------------------------------

  const marks = useMemo(() => marksOf(effective), [effective])

  const draft = useMemo<DraftStorm | null>(
    () => (kind && draftPath ? { kind, level, radius: radiusOf(kind, level), path: draftPath } : null),
    [kind, level, draftPath],
  )

  const hover = useMemo<HoverStorm | null>(
    () => (armed && !draftPath && kind && hoverAt ? { kind, level, radius: radiusOf(kind, level), at: hoverAt } : null),
    [armed, draftPath, kind, level, hoverAt],
  )

  const staged = useMemo(() => stagedOf(plan.events, running ? started : undefined), [plan.events, running, started])

  const canvas = useMemo<Omit<WeatherCanvasProps, 'map'>>(() => {
    const liveIds = new Set(live.map((l) => l.storm.id))
    return {
      tracks: effective.storms.filter((s) => !liveIds.has(s.id)),
      live,
      draft,
      hover,
      marks,
      staged,
      selectedId,
      campus,
    }
  }, [effective, live, draft, hover, marks, staged, selectedId, campus])

  const stale = runState === 'done' && ranVersion !== null && version !== ranVersion

  const dock = useMemo<ComposerDockProps>(
    () => ({
      open,
      onOpen,
      kind,
      level,
      onKind,
      onLevel,
      phase,
      preview: armed || draftPath ? preview : null,
      events: plan.events,
      selectedId,
      onSelect: select,
      onUpdate,
      onRemove,
      onAddHazard,
      onAddFault,
      onRun,
      onStop,
      onClear,
      run: clock,
      stale,
      live,
      landed,
      last,
      history: effective.storms,
      speed,
      onSpeed: setSpeed,
      degraded,
      error,
      startsAt: plan.startsAt,
      onStartsAt,
    }),
    [
      open,
      onOpen,
      kind,
      level,
      onKind,
      onLevel,
      phase,
      armed,
      draftPath,
      preview,
      plan,
      selectedId,
      select,
      onUpdate,
      onRemove,
      onAddHazard,
      onAddFault,
      onRun,
      onStop,
      onClear,
      clock,
      stale,
      live,
      landed,
      last,
      effective,
      speed,
      degraded,
      error,
      onStartsAt,
    ],
  )

  return { armed, effective, canvas, dock, toggleRoute, clear }
}

// ---------------------------------------------------------------------------

/** The campus with exactly these nodes down. */
function withDown(nodes: readonly SimNode[], down: ReadonlySet<string>): SimNode[] {
  return nodes.map((node) => (node.failed === down.has(node.id) ? node : { ...node, failed: down.has(node.id) }))
}

/** Weather minus storms the engine has been told to forget, and what they left behind. */
function without(w: WeatherState, retired: ReadonlySet<string>): WeatherState {
  if (retired.size === 0) return w
  const keep = (id: string | null | undefined) => !id || !retired.has(id)
  return {
    storms: w.storms.filter((s) => keep(s.id)),
    closed_routes: w.closed_routes.filter((r) => keep(r.storm_id)),
    cut_edges: w.cut_edges.filter((e) => keep(e.storm_id)),
    closed_roads: w.closed_roads.filter((e) => keep(e.storm_id)),
  }
}

/** The short detail for the scenario strip when a whole run ends. */
function describe(landed: readonly Impact[]): string {
  const conditions = landed.filter((i) => i.key.startsWith('hazard:')).map((i) => i.label.replace(/ arrived$/, ''))
  const rest = landed.filter((i) => !i.key.startsWith('hazard:'))
  const counts = tally(rest)
  const parts = [...new Set(conditions), ...counts]
  if (parts.length === 0) return 'Nothing on campus was hit'
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
/** Simplify a drawn path, loosening until it fits the point budget. */
function fitPath(raw: readonly LngLat[]): LngLat[] {
  let tolerance = 8
  let path = simplify(raw, tolerance)
  while (path.length > MAX_POINTS) {
    tolerance *= 1.6
    path = simplify(raw, tolerance)
  }
  return path
}

/** Bus shapes with vertices at least `step` meters apart. */
function thin(buses: readonly BusLine[], step: number): BusLine[] {
  return buses.map((bus) => {
    const coords: LngLat[] = []
    for (const p of bus.coords) if (coords.length === 0 || dist(coords[coords.length - 1], p) >= step) coords.push(p)
    const end = bus.coords[bus.coords.length - 1]
    if (end && coords[coords.length - 1] !== end) coords.push(end)
    return { ...bus, coords }
  })
}

/** Impacts landing within BATCH_MS of the first in a group go out together. */
function batches(impacts: readonly Impact[], duration: number): Impact[][] {
  const out: Impact[][] = []
  let group: Impact[] = []
  let start = 0
  for (const impact of impacts) {
    const at = impact.t * duration
    if (group.length > 0 && at - start > BATCH_MS) {
      out.push(group)
      group = []
    }
    if (group.length === 0) start = at
    group.push(impact)
  }
  if (group.length > 0) out.push(group)
  return out
}

function addHit(w: WeatherState, stormId: string, impact: Impact): WeatherState {
  if (impact.target === 'bus' && impact.route) {
    const { id, name, segments } = impact.route
    return { ...w, closed_routes: [...w.closed_routes, { id, name, segments, reason: impact.detail, storm_id: stormId }] }
  }
  if (!impact.edgeId) return w
  const mark: EdgeMark = { id: impact.edgeId, at: impact.at, storm_id: stormId }
  if (impact.target === 'line') return { ...w, cut_edges: [...w.cut_edges, mark] }
  if (impact.target === 'road') return { ...w, closed_roads: [...w.closed_roads, mark] }
  return w
}

function toHit(storm: Storm, batch: readonly Impact[], nameOf: (id: string) => string): StormHit {
  const fail = new Set<string>()
  const hit: StormHit = { storm_id: storm.id, fail: [], derate: [], cut_edges: [], close_roads: [], close_routes: [], lines: [] }
  for (const impact of batch) {
    if (impact.action === 'fail' || impact.action === 'cut') impact.nodeIds.forEach((id) => fail.add(id))
    if (impact.action === 'derate' && impact.factor !== undefined) {
      for (const id of impact.nodeIds) hit.derate.push({ node_id: id, factor: impact.factor })
    }
    if (impact.edgeId && impact.target === 'line') hit.cut_edges.push({ id: impact.edgeId, at: impact.at, storm_id: storm.id })
    if (impact.edgeId && impact.target === 'road') hit.close_roads.push({ id: impact.edgeId, at: impact.at, storm_id: storm.id })
    if (impact.target === 'bus' && impact.route) {
      const { id, name, segments } = impact.route
      hit.close_routes.push({ id, name, segments, reason: impact.detail, storm_id: storm.id })
    }
    // Road closures are folded into one line below, so they don't crowd the agents out of the short feed.
    if (impact.target === 'road') continue
    const line = hitLine(storm, impact, nameOf)
    if (!hit.lines.includes(line)) hit.lines.push(line)
  }
  const roads = batch.filter((impact) => impact.target === 'road')
  if (roads.length === 1) hit.lines.push(hitLine(storm, roads[0], nameOf))
  else if (roads.length > 1) hit.lines.push(`${roads.length} campus roads closed (${roads[0].detail}). Transit routes around them`)
  hit.fail = [...fail]
  return hit
}

/** Apply a batch through /disrupt. True when the engine was written. */
async function viaDisrupt(hit: StormHit, label: string): Promise<boolean> {
  const reason = hit.lines.length === 1 ? hit.lines[0] : label
  if (hit.fail.length > 0) await disrupt(hit.fail, 'fail', reason)
  const byFactor = new Map<number, string[]>()
  for (const d of hit.derate) {
    if (hit.fail.includes(d.node_id)) continue
    byFactor.set(d.factor, [...(byFactor.get(d.factor) ?? []), d.node_id])
  }
  for (const [factor, ids] of byFactor) await disrupt(ids, 'derate', reason, factor)
  return hit.fail.length > 0 || byFactor.size > 0
}

/** One line for the agent feed. */
function hitLine(storm: Storm, impact: Impact, nameOf: (id: string) => string): string {
  const { label, detail } = impact
  const ordered = storm.kind === 'closure' || storm.kind === 'blackout'
  switch (impact.action) {
    case 'fail':
      if (impact.nodeIds.length === 0) return `${label} hit (${detail}), already offline`
      if (detail === 'direct hit') return `${label} took a direct hit and is offline`
      if (detail === 'lightning strike') return `Lightning struck ${label}, now offline`
      if (detail === 'switchgear under water') return `${label} switchgear under water, building offline`
      if (detail === 'power cut') return `Power cut to ${label}`
      return `${label} offline (${detail})`
    case 'derate':
      return `${label} ${detail}`
    case 'cut': {
      const dark = impact.nodeIds.map(nameOf)
      return `${label} line ${ordered ? 'cut' : `down (${detail})`}${dark.length > 0 ? `, ${dark.join(', ')} dark` : ''}`
    }
    case 'close':
      if (impact.target === 'bus') {
        if (storm.kind === 'closure') return `${label} closed by the director`
        return `${label} closed ${storm.path.length > 1 ? 'near the track' : 'in the storm'} (${detail})`
      }
      return storm.kind === 'closure' ? `${label} road closed by the director` : `${label} road closed (${detail})`
  }
}

const OPENING: Record<StormKind, { path: [string, string]; point: [string, string] }> = {
  tornado: { path: ['touched down', 'near'], point: ['touched down', 'at'] },
  thunderstorm: { path: ['rolled in', 'near'], point: ['rolled in', 'over'] },
  ice: { path: ['moved in', 'near'], point: ['settled', 'over'] },
  flood: { path: ['broke out', 'near'], point: ['broke out', 'around'] },
  blizzard: { path: ['moved in', 'near'], point: ['settled', 'over'] },
  lightning: { path: ['struck', 'near'], point: ['struck', 'near'] },
  blackout: { path: ['ordered', 'near'], point: ['ordered', 'around'] },
  closure: { path: ['ordered', 'near'], point: ['ordered', 'at'] },
}

/** "Markley Hall" when the point is on campus, else "west of campus". */
function where(p: LngLat, preposition: string): string {
  let best = { name: '', d: Infinity }
  for (const [id, place] of Object.entries(PLACES)) {
    if (CITY.has(id)) continue
    const d = dist(p, [place.lng, place.lat])
    if (d < best.d) best = { name: place.short, d }
  }
  if (best.d > 1200) return `${compass(bearing(CAMPUS, p))} of campus`
  return `${preposition} ${best.name}`
}

/** "EF3 tornado touched down near Markley Hall, heading north-east for 2.1 km" */
function headline(storm: Storm): string {
  const start = storm.path[0]
  const end = storm.path[storm.path.length - 1]
  const moving = storm.path.length > 1
  const km = (pathLength(storm.path) / 1000).toFixed(1)
  const dir = moving ? compass(bearing(start, end)) : ''
  if (storm.kind === 'lightning') {
    const who = ['Lightning', 'Strong lightning', 'A superbolt'][storm.level] ?? 'Lightning'
    return `${who} struck ${where(start, 'near')}`
  }
  const [verb, preposition] = moving ? OPENING[storm.kind].path : OPENING[storm.kind].point
  const tool = storm.kind === 'blackout' || storm.kind === 'closure'
  const tail = !moving ? '' : tool ? `, along ${km} km to the ${dir}` : `, heading ${dir} for ${km} km`
  return `${storm.label} ${verb} ${where(start, preposition)}${tail}`
}

const ENDING: Partial<Record<StormKind, string>> = {
  tornado: 'passed',
  thunderstorm: 'passed',
  ice: 'ended',
  flood: 'receded',
  blizzard: 'ended',
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "3 buildings dark", "1 line down": one part per kind of damage, in a fixed order. */
function tally(impacts: readonly Impact[]): string[] {
  const dark = new Set<string>()
  const buses = new Set<string>()
  let derated = 0
  let lines = 0
  let roads = 0
  for (const impact of impacts) {
    if (impact.action === 'fail' || impact.action === 'cut') impact.nodeIds.forEach((id) => dark.add(id))
    if (impact.action === 'derate') derated++
    if (impact.target === 'line') lines++
    if (impact.target === 'bus') buses.add(impact.route?.id ?? impact.key)
    if (impact.target === 'road') roads++
  }
  return [
    dark.size > 0 && `${plural(dark.size, 'building', 'buildings')} dark`,
    derated > 0 && `${plural(derated, 'feed', 'feeds')} derated`,
    lines > 0 && `${plural(lines, 'line', 'lines')} down`,
    buses.size > 0 && `${plural(buses.size, 'bus line', 'bus lines')} closed`,
    roads > 0 && `${plural(roads, 'road', 'roads')} closed`,
  ].filter((part): part is string => Boolean(part))
}

/** The feed line when a storm ends. */
function summarize(storm: Storm, impacts: readonly Impact[]): { line: string } {
  const parts = tally(impacts)
  const verb = ENDING[storm.kind]
  if (parts.length === 0) {
    const line = verb
      ? `${storm.label} ${verb} without hitting anything on campus`
      : storm.kind === 'lightning'
        ? `${storm.label} hit nothing on campus`
        : `${storm.label}: nothing on campus inside it`
    return { line }
  }
  const counts = parts.join(', ')
  return { line: verb ? `${storm.label} ${verb}: ${counts}` : `${storm.label}: ${counts}` }
}

/** Server first, then what the browser knows. Later copies of the same thing are dropped. */
function merge(...parts: WeatherState[]): WeatherState {
  const storms = new Map<string, StormRecord>()
  const routes = new Map<string, ClosedRoute>()
  const cuts = new Map<string, EdgeMark>()
  const roads = new Map<string, EdgeMark>()
  for (const w of parts) {
    for (const s of w.storms) {
      const had = storms.get(s.id)
      if (!had || (had.status === 'active' && s.status === 'done')) storms.set(s.id, s)
    }
    for (const r of w.closed_routes) {
      const key = `${r.storm_id ?? ''}|${r.id}|${r.segments === null ? 'all' : 'part'}`
      if (!routes.has(key)) routes.set(key, r)
    }
    for (const e of w.cut_edges) if (!cuts.has(e.id)) cuts.set(e.id, e)
    for (const e of w.closed_roads) if (!roads.has(e.id)) roads.set(e.id, e)
  }
  return { storms: [...storms.values()], closed_routes: [...routes.values()], cut_edges: [...cuts.values()], closed_roads: [...roads.values()] }
}

/** One mark per closed stretch of bus line, cut line and closed road. */
function marksOf(w: WeatherState): MapMark[] {
  const out: MapMark[] = []
  const placed: LngLat[] = []
  for (const r of w.closed_routes) {
    if (!r.segments) continue
    r.segments.forEach((segment, i) => {
      if (segment.length === 0) return
      const at = segment[Math.floor(segment.length / 2)]
      // Both directions of a line, and lines sharing a street, close together; one mark is enough.
      if (placed.some((p) => dist(p, at) < 120)) return
      placed.push(at)
      out.push({ key: `${r.storm_id ?? 'director'}|${r.id}|${i}`, kind: 'bus', at })
    })
  }
  for (const e of w.cut_edges) out.push({ key: `line:${e.id}`, kind: 'line', at: e.at })
  for (const e of w.closed_roads) out.push({ key: `road:${e.id}`, kind: 'road', at: e.at })
  return out
}

function message(err: unknown): string {
  if (err instanceof TypeError) return 'Engine unreachable. Hits are kept on the map only.'
  return err instanceof Error ? err.message : String(err)
}
