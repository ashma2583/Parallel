/**
 * Controller for the scenario composer. The director stacks weather drawn on
 * the map, campus-wide conditions and equipment faults into one plan, edits
 * it, then runs it. A run puts the campus back the way it was before the first
 * run of this plan, then plays every event on one clock and sends each hit to
 * the engine as it lands. An engine without weather routes still gets the hits
 * through /disrupt; the storms and their closures then live here.
 *
 * A campus reset ends a run at once: the engine's tick going back to zero, or a
 * new "campus reset" in its feed, is looked for every second while a run plays.
 * A run reports what it did only once its last writes have reached the engine.
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
  fetchCampus,
  fetchMark,
  fetchStorms,
  hitStorm,
  markLive,
  MAX_STORMS,
  NoStormRoutes,
  readCuts,
  resetSince,
  restoreRoute,
  runScenario,
  saveCuts,
  startStorm,
  StormGone,
  suspendRoute,
  unmarkLive,
  type CampusMark,
  type EngineMark,
  type StormCut,
  type StormHit,
} from '../../lib/weather/api'
import {
  bearing,
  compass,
  cumulative,
  dist,
  distPointPath,
  growRadius,
  headFraction,
  runDuration,
  simplify,
  slicePath,
  STRIKE,
  travel,
} from '../../lib/weather/geo'
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
  STORM_HAZARD,
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
  type ImpactCounts,
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
  /** The map view is on screen. Keys only edit the plan while it is. */
  active?: boolean
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
  /** A run finished, or was stopped part way. */
  onStorm?: (s: StormNote) => void
}

/** What a run did, for the scenario strip. `counts` and `conditions` are left out when part of it never reached the engine. */
export interface StormNote {
  label: string
  detail: string
  counts?: ImpactCounts
  conditions?: string[]
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
  /**
   * What the run playing now, or the last one, is made of, in plan order: engine ids of
   * its campus-wide conditions, and "storm:<kind>" for weather drawn on the map.
   */
  hazards: string[]
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
/** A press this close to a planned storm's path grabs it, or anywhere inside one drawn smaller than GRAB_MAX_PX. */
const GRAB_PX = 16
const GRAB_MAX_PX = 40
const MAX_POINTS = 80
const PREVIEW_MS = 120
/** Hits landing this close together go to the engine as one write. */
const BATCH_MS = 120
/** Trust a write's reply over the polled briefing for this long. */
const HOLD_MS = 1500
/** How often to look for a campus reset while a run plays or the browser holds weather. */
const WATCH_MS = 1000
/** More than this many bus lines closing at once share one feed line. */
const BUS_LINES_EACH = 3
/** A second click on the same condition or fault this soon after the first adds nothing. */
const REPEAT_MS = 700
/** Engine writes this close together share one pull of engine state. */
const NOTIFY_MS = 150
/** Longest a finished run waits for its last writes before it reports anyway. */
const SETTLE_MS = 15_000

const CITY = new Set(['city_hall', 'blake', 'fire_1'])
const CAMPUS: LngLat = [-83.728, 42.284]
const NONE: ReadonlySet<string> = new Set()

/** Requests already acted on. Lives outside the hook so a remounted map does not replay one. */
let handledRequest: number | undefined
let handledSignal: number | undefined = 0
/**
 * The run allowed to write to the engine. Outside the hook so a run keeps going
 * when the map view is left, and a run started after it, or a reset, stops it.
 */
const runs = { token: 0 }

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

/** One run of the plan. Every timer and engine write checks its token against runs.token before acting. */
interface Run {
  token: number
  events: ScenarioEvent[]
  speed: number
  /** Storms started in this run. */
  stormIds: Set<string>
  /** Storms the engine put on record for this run. */
  recorded: Set<string>
  /** Nodes down right now in this run: the restored campus plus every hit so far. Impacts are scored against it. */
  down: Set<string>
  /** Planned buildings for this run. Null means the current ones; empty after a plain reset cleared them. */
  proposals: readonly ProposalPin[] | null
  /** Everything that has landed, oldest first. */
  landed: Impact[]
  /** Engine writes for this run, in order. Stop still sends the ones the queue had not reached. */
  writes: { sent: boolean; job: (current: () => boolean) => Promise<void> }[]
  /** Hits for a storm still waiting in the queue. Later hits for it ride along in the same write. */
  hits: Map<string, StormHit>
  /** The campus when the run began, after it was put back. Null when it could not be read. */
  before: CampusMark | null
  /** The engine refused one of this run's writes. */
  failed: boolean
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
  // Short words for the dock, and the engine's own for a tooltip.
  const [error, setError] = useState<{ text: string; detail?: string } | null>(null)
  const [runHazards, setRunHazards] = useState<string[]>([])
  const [settling, setSettling] = useState(false)
  // Storms stopped part way, by id: the map draws them only as far as they got.
  const [cuts, setCuts] = useState<Record<string, StormCut>>(readCuts)

  const level = kind ? levels[kind] : 0
  const running = runState === 'running'
  const armed = open && kind !== null && !running
  const phase: DockPhase = running ? 'running' : draftPath ? 'drawing' : armed ? 'armed' : runState === 'done' ? 'done' : 'idle'

  const [signal, setSignal] = useState(() => handledSignal)
  if (openSignal !== undefined && openSignal !== signal) {
    setSignal(openSignal)
    if (openSignal > 0) setOpen(true)
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
  const openRef = useRef(open)
  const lastAdd = useRef<{ what: string; at: number; id: string } | null>(null)
  const lastDrop = useRef<{ kind: StormKind; x: number; y: number; at: number } | null>(null)
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
  /** Run writes queued and not yet answered. */
  const pending = useRef(0)
  const degradedRef = useRef(false)
  /** Storms the engine has shown it has on record. */
  const confirmed = useRef(new Set<string>())
  const retiredRef = useRef(retired)
  const liveRef = useRef<LiveStorm[]>([])
  const runRef = useRef<Run | null>(null)
  const runningRef = useRef(false)
  /** The engine's mark as last seen, for spotting a reset. Paused while a run puts the campus back itself. */
  const watch = useRef<{ mark: EngineMark | null; gen: number; paused: boolean; pending: Promise<boolean> | null; at: number }>({
    mark: null,
    gen: 0,
    paused: false,
    pending: null,
    at: 0,
  })

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
    openRef.current = open
  }, [open])
  useEffect(() => {
    selectedRef.current = selectedId
  }, [selectedId])
  useEffect(() => {
    handledRequest = seenRequest
  }, [seenRequest])
  useEffect(() => {
    handledSignal = signal
  }, [signal])
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

  // Writes land in quick bursts during a run. One pull of engine state covers a burst.
  const notifyTimer = useRef(0)
  const notify = useCallback(() => {
    if (notifyTimer.current) return
    notifyTimer.current = window.setTimeout(() => {
      notifyTimer.current = 0
      optsRef.current.onChanged()
    }, NOTIFY_MS)
  }, [])

  const fail = useCallback((err: unknown) => setError(message(err)), [])

  const hint = useCallback((text: string, ms = 2600) => {
    const shown = { text }
    setError(shown)
    window.clearTimeout(hintTimer.current)
    hintTimer.current = window.setTimeout(() => setError((now) => (now === shown ? null : now)), ms)
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

  /** Weather the engine still has in force is drawn again, even from storms retired when a run started. */
  const unretire = useCallback((weather: WeatherState) => {
    const ids = new Set<string>(weather.storms.map((s) => s.id))
    for (const r of weather.closed_routes) if (r.storm_id) ids.add(r.storm_id)
    for (const e of [...weather.cut_edges, ...weather.closed_roads]) if (e.storm_id) ids.add(e.storm_id)
    if (![...ids].some((id) => retiredRef.current.has(id))) return
    const next = new Set(retiredRef.current)
    for (const id of ids) next.delete(id)
    retiredRef.current = next
    setRetired(next)
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

  // A run outlives the map: leaving for the grid view lets it finish on the engine.
  useEffect(
    () => () => {
      window.clearTimeout(previewTimer.current)
      // Zeroed too: a remount (StrictMode does one) would otherwise see a timer pending that never fires, and never preview.
      previewTimer.current = 0
      window.clearTimeout(freshTimer.current)
      window.clearTimeout(hintTimer.current)
      window.clearTimeout(notifyTimer.current)
      notifyTimer.current = 0
    },
    [],
  )

  /**
   * Drop weather kept in the browser for these storms, or all of it after a reset.
   * A run they belong to stops. True when a run was stopped.
   */
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
      // After a reset no run may write, including one still playing for a map that was closed.
      if (cancel || ids === null) runs.token++
      if (cancel) {
        clearRun()
        runningRef.current = false
        liveRef.current = []
        setLive([])
        setClock(null)
        setSettling(false)
      }
      setCampus([])
      setLanded([])
      setLast(null)
      setRemote(null)
      setFresh(false)
      setRunState((now) => (now === 'done' || (cancel && now === 'running') ? 'none' : now))
      return cancel
    },
    [clearRun],
  )

  const clear = useCallback(() => {
    confirmed.current.clear()
    setCuts(saveCuts(null))
    if (forget(null)) hint('Campus reset. The run stopped.')
  }, [forget, hint])

  /** Remember how far these storms got, so they are drawn only that far. */
  const cutOff = useCallback((items: readonly LiveStorm[]) => {
    if (items.length === 0) return {}
    const now = performance.now()
    const made = Object.fromEntries(items.map((l) => [l.storm.id, cutAt(l, now)]))
    setCuts(saveCuts({ ...readCuts(), ...made }))
    return made
  }, [])

  // A reload part way through a run ends its storms where they were when the page went away.
  useEffect(() => {
    const away = () => {
      if (runningRef.current) cutOff(liveRef.current)
    }
    window.addEventListener('pagehide', away)
    return () => window.removeEventListener('pagehide', away)
  }, [cutOff])

  /**
   * Look at the engine once. True when it was reset since the last look; the
   * weather kept here is then cleared and any run stopped. Concurrent callers share one look.
   */
  const probe = useCallback((): Promise<boolean> => {
    const w = watch.current
    if (w.paused) return Promise.resolve(false)
    if (w.pending) return w.pending
    const gen = w.gen
    w.at = performance.now()
    const look = fetchMark()
      .then((now) => {
        if (!now || gen !== w.gen || w.paused) return false
        const before = w.mark
        w.mark = { ...now, reset: now.reset ?? before?.reset ?? null }
        if (!before || !resetSince(before, now)) return false
        clear()
        return true
      })
      .finally(() => {
        if (w.pending === look) w.pending = null
      })
    w.pending = look
    return look
  }, [clear])

  /** Stop looking, e.g. while a run puts the campus back itself, and forget the last look. */
  const pauseWatch = useCallback(() => {
    const w = watch.current
    w.paused = true
    w.gen++
    w.pending = null
    w.mark = null
  }, [])

  /** Look again, starting from the engine as it is now. */
  const resumeWatch = useCallback(async () => {
    watch.current.paused = false
    await probe()
  }, [probe])

  /**
   * Queue an engine write for a run. Skipped once the run is over or the engine was reset.
   * The watch already looks for a reset every second while a run plays, so a write only looks itself when that has gone quiet.
   */
  const write = useCallback(
    (run: Run, job: () => Promise<void>) => {
      pending.current++
      enqueue(async () => {
        try {
          if (run.token !== runs.token) return
          if (performance.now() - watch.current.at > WATCH_MS && (await probe())) return
          if (run.token !== runs.token) return
          await job()
        } catch (err) {
          run.failed = true
          throw err
        } finally {
          pending.current--
        }
      })
    },
    [enqueue, probe],
  )

  /** A run's engine write. Stop still sends it if the queue had not got to it, so the campus matches what landed on screen. */
  const owe = useCallback(
    (run: Run, job: (current: () => boolean) => Promise<void>) => {
      const item = { sent: false, job }
      run.writes.push(item)
      write(run, async () => {
        item.sent = true
        await job(() => run.token === runs.token)
      })
    },
    [write],
  )

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
  const commit = useCallback((events: ScenarioEvent[]) => {
    const next: ScenarioPlan = { events: sortEvents(events), startsAt: planRef.current.startsAt }
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
      if (runningRef.current || !events.some((e) => e.id === id)) return
      commit(events.filter((e) => e.id !== id))
      if (selectedRef.current === id) select(null)
    },
    [commit, select],
  )

  /** Add a condition or fault, unless this is a quick repeat click on the one just added. */
  const addOnce = useCallback(
    (what: string, make: (start: number) => ScenarioEvent) => {
      setOpen(true)
      const now = performance.now()
      const prev = lastAdd.current
      if (prev && prev.what === what && now - prev.at < REPEAT_MS && planRef.current.events.at(-1)?.id === prev.id) {
        prev.at = now
        return
      }
      lastAdd.current = { what, at: now, id: add(make).id }
    },
    [add],
  )

  const onAddHazard = useCallback((hazard: HazardKind) => addOnce(`hazard:${hazard}`, (start) => hazardEvent(hazard, start)), [addOnce])

  const onAddFault = useCallback((fault: FaultKind) => addOnce(`fault:${fault}`, (start) => faultEvent(fault, start)), [addOnce])

  // Only the clock labels follow the start time, so changing it alone does not ask for a re-run.
  const onStartsAt = useCallback((value: string) => {
    const parsed = parseClock(value)
    if (!parsed) return
    const startsAt = `${String(parsed[0]).padStart(2, '0')}:${String(parsed[1]).padStart(2, '0')}`
    if (startsAt === planRef.current.startsAt) return
    const next: ScenarioPlan = { ...planRef.current, startsAt }
    planRef.current = next
    setPlan(next)
  }, [])

  /** Put the plan back as it was at `at`, e.g. when Escape cancels a drag. */
  const restorePlan = useCallback((events: ScenarioEvent[], at: number) => {
    const next: ScenarioPlan = { ...planRef.current, events }
    planRef.current = next
    setPlan(next)
    versionRef.current = at
    setVersion(at)
  }, [])

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
    const { km, heading } = travel(path)
    previewCost.current = performance.now() - started
    setPreview({ lengthKm: km, heading, counts: countImpacts(impacts), impacts })
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
    async (run: Run, storm: Storm, hit: StormHit, current: () => boolean) => {
      if (!degradedRef.current) {
        try {
          const weather = await hitStorm(hit)
          // Null: the engine dropped this storm when a newer run put the campus back.
          if (weather && current()) {
            accept(weather)
            notify()
          }
          return
        } catch (err) {
          // The engine forgot a storm it had on record: it was reset, so this run is over.
          if (err instanceof StormGone) {
            if (current() && run.recorded.has(storm.id)) clear()
            return
          }
          if (err instanceof NoStormRoutes) markDegraded(true)
          else {
            run.failed = true
            fail(err)
          }
        }
      }
      if (current() && (await viaDisrupt(hit, storm.label, current))) notify()
    },
    [accept, clear, fail, markDegraded, notify],
  )

  /**
   * A storm's batch of hits on its way to the engine. While a write for the same
   * storm is still waiting in the queue, the batch rides along in it, so a busy page sends fewer, larger writes.
   */
  const sendLater = useCallback(
    (run: Run, storm: Storm, hit: StormHit) => {
      const waiting = run.hits.get(storm.id)
      if (waiting) {
        run.hits.set(storm.id, mergeHits(waiting, hit))
        return
      }
      run.hits.set(storm.id, hit)
      owe(run, async (now) => {
        const all = run.hits.get(storm.id)
        run.hits.delete(storm.id)
        if (all) await send(run, storm, all, now)
      })
    },
    [owe, send],
  )

  /** Something arrived: on the ticker, and into what later storms see as down. */
  const land = useCallback((run: Run, impact: Impact) => {
    run.landed.push(impact)
    if (impact.action === 'fail' || impact.action === 'cut') for (const id of impact.nodeIds) run.down.add(id)
    setLanded((prev) => [...prev, impact])
  }, [])

  /** End a storm on the engine. `cut` is how far one stopped part way got. */
  const endLater = useCallback(
    (storm: Storm, summary: string, cut?: StormCut) => {
      setLocal((prev) => ({ ...prev, storms: [...prev.storms.filter((s) => s.id !== storm.id), { ...storm, status: 'done' }] }))
      enqueue(async () => {
        if (degradedRef.current) return
        try {
          const weather = await endStorm(storm.id, summary, cut?.path)
          if (weather) accept(weather)
          // The engine's record wins from here on, e.g. a cut line it repaired when its building was restored.
          setLocal((prev) => dropStorm(prev, storm.id))
          unmarkLive(storm.id)
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
      const current = () => run.token === runs.token

      run.stormIds.add(storm.id)
      liveRef.current = [...liveRef.current, item]
      setLive(liveRef.current)

      owe(run, async (current) => {
        if (degradedRef.current) return
        // Kept until the storm ends, so a reload part way can end it on the engine.
        markLive(storm)
        try {
          const weather = await startStorm({ ...storm, headline: headline(storm) })
          if (!current()) return
          // On record now: if a poll stops showing it, the engine was reset or the poll is stale.
          run.recorded.add(storm.id)
          confirmed.current.add(storm.id)
          accept(weather)
          markDegraded(false)
          notify()
        } catch (err) {
          if (err instanceof NoStormRoutes || err instanceof TypeError) markDegraded(true)
          else {
            run.failed = true
            fail(err)
          }
        }
      })

      // A batch lands on screen as it goes to the engine, so a Stop between the two cannot split them.
      for (const batch of batches(impacts, duration)) {
        later(batch[batch.length - 1].t * duration, () => {
          if (!current()) return
          for (const impact of batch) land(run, impact)
          setLocal((prev) => batch.reduce((w, impact) => addHit(w, storm.id, impact), prev))
          sendLater(run, storm, toHit(storm, batch, nameOf))
        })
      }

      later(duration + 80, () => {
        if (!current()) return
        liveRef.current = liveRef.current.filter((l) => l.storm.id !== storm.id)
        setLive(liveRef.current)
        endLater(storm, summarize(storm, impacts).line)
      })
    },
    [accept, endLater, fail, land, later, markDegraded, notify, owe, sendLater],
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
      owe(run, async () => {
        const reply = await applyHazard(spec.hazardId)
        // Some conditions fail a feed outright; later storms should see it down.
        for (const id of downIn(reply) ?? []) run.down.add(id)
        notify()
      })
    },
    [land, notify, owe],
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
      owe(run, async () => {
        await disrupt([...spec.nodeIds], 'fail', spec.reason)
        notify()
      })
    },
    [land, notify, owe],
  )

  /** Tell the dock and the strip what a run did. `after` is the campus once its writes landed, when it could be read. */
  const report = useCallback((run: Run, after: CampusMark | null, stopped: boolean) => {
    const single = run.events.length === 1
    const label = single ? eventLabel(run.events[0]) : 'Scenario'
    const { counts, conditions } = outcomeOf(run.landed, run.before, after)
    setLast({ label, counts, note: conditions.join(' · ') || undefined, stopped: stopped || undefined, failed: run.failed || undefined })
    const name = single ? (stopped ? `${label} stopped` : label) : `${stopped ? 'Scenario stopped' : 'Scenario'}: ${planNames(run.events)}`
    optsRef.current.onStorm?.(
      run.failed ? { label: name, detail: 'Part of it did not reach the engine' } : { label: name, detail: describe(counts, conditions), counts, conditions },
    )
  }, [])

  const finish = useCallback(
    (run: Run, after: CampusMark | null) => {
      runningRef.current = false
      liveRef.current = []
      setLive([])
      setClock(null)
      setSettling(false)
      setRunState('done')
      report(run, after, false)
    },
    [report],
  )

  /** The run has played out on screen. Its last writes may still be on the way: wait for them, then read what it did. */
  const settle = useCallback(
    (run: Run) => {
      if (pending.current > 0) setSettling(true)
      void Promise.race([queue.current, wait(SETTLE_MS)]).then(async () => {
        if (run.token !== runs.token) return
        const after = await fetchCampus()
        if (run.token === runs.token) finish(run, after)
      })
    },
    [finish],
  )

  /** The engine would not start the run. Nothing plays. */
  const abort = useCallback((run: Run) => {
    runningRef.current = false
    run.failed = true
    setClock(null)
    setSettling(false)
    setRunState('done')
    const single = run.events.length === 1
    setLast({ label: single ? eventLabel(run.events[0]) : 'Scenario', counts: countImpacts([]), failed: true })
  }, [])

  /** Play every event on one clock, from now. */
  const begin = useCallback(
    (run: Run) => {
      const total = planTotal(run.events, run.speed)
      setClock({ startedAt: performance.now(), total })
      run.events.forEach((event, index) => {
        later((event.start * 1000) / run.speed, () => {
          if (run.token !== runs.token) return
          setStarted((prev) => new Set(prev).add(event.id))
          if (event.type === 'storm') playStorm(run, event, index)
          else if (event.type === 'hazard') playHazard(run, event)
          else playFault(run, event)
        })
      })
      later(total + 120, () => {
        if (run.token === runs.token) settle(run)
      })
    },
    [later, playFault, playHazard, playStorm, settle],
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
    // Nothing is picked while it plays, so Delete cannot pull an event out of the saved plan.
    select(null)
    hoverRef.current = null
    setHoverAt(null)
    stopPreview()

    clearRun()
    const token = ++runs.token
    const run: Run = {
      token,
      events: [...events],
      speed: speedRef.current,
      stormIds: new Set(),
      recorded: new Set(),
      down: new Set(),
      proposals: null,
      landed: [],
      writes: [],
      hits: new Map(),
      before: null,
      failed: false,
    }
    setRunHazards(
      events.flatMap((e) => (e.type === 'hazard' ? [HAZARD_SPECS[e.hazard].hazardId] : e.type === 'storm' && STORM_HAZARD[e.kind] ? [`storm:${e.kind}`] : [])),
    )
    // The engine clears the storms of earlier runs when this one starts.
    unmarkLive(null)
    runRef.current = run
    runningRef.current = true

    // The engine drops weather from earlier runs. Stop counting on it, so it is not read as a reset.
    // Whatever it keeps, e.g. weather from before a Clear, comes back with its reply below.
    const gone = new Set(retiredRef.current)
    for (const s of local.storms) gone.add(s.id)
    for (const s of (remote ?? EMPTY_WEATHER).storms) gone.add(s.id)
    for (const s of (server ? asWeather(server) : EMPTY_WEATHER).storms) gone.add(s.id)
    for (const id of confirmed.current) gone.add(id)
    retiredRef.current = gone
    setRetired(gone)
    confirmed.current.clear()

    liveRef.current = []
    setLive([])
    setCampus([])
    setLanded([])
    setLast(null)
    setError(null)
    setSettling(false)
    setStarted(NONE)
    setClock(null)
    setLocal(EMPTY_WEATHER)
    setRemote(null)
    setFresh(false)
    setRunState('running')
    setRanVersion(versionRef.current)

    const current = () => token === runs.token
    enqueue(async () => {
      if (!current()) return
      let wiped = false
      let refused = false
      // The run's own restore, or reset, must not read as a reset that stops it.
      pauseWatch()
      try {
        const reply = await runScenario()
        if (current()) {
          unretire(reply.weather)
          accept(reply.weather)
        }
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
          // Unreachable plays on the map only. An engine that answered and refused would refuse the hits too.
          refused = !(err instanceof TypeError)
        }
      } finally {
        await resumeWatch()
      }
      if (!current()) return
      if (refused) {
        abort(run)
        return
      }
      notify()
      const campus = await fetchCampus()
      if (!current()) return
      run.down = campus?.down ?? (wiped ? new Set() : new Set(optsRef.current.nodes.filter((n) => n.failed).map((n) => n.id)))
      run.before = campus
      run.proposals = wiped ? [] : null
      begin(run)
    })
  }, [abort, accept, begin, cancelDraw, clearRun, enqueue, fail, hint, local, notify, pauseWatch, remote, resumeWatch, select, server, stopPreview, unretire])

  const onStop = useCallback(() => {
    const run = runRef.current
    if (!run || !runningRef.current) return
    const stopped = ++runs.token
    clearRun()
    runningRef.current = false
    const stopping = liveRef.current
    liveRef.current = []
    setLive([])
    setClock(null)
    setRunState('done')
    // Hits already on screen still reach the engine, so the campus matches the counts. A new run or a reset cancels this.
    setSettling(false)
    const current = () => runs.token === stopped
    const owed = run.writes.filter((w) => !w.sent)
    if (owed.length > 0) {
      enqueue(async () => {
        if (!current() || (await probe())) return
        for (const w of owed) {
          if (!current()) return
          w.sent = true
          try {
            await w.job(current)
          } catch (err) {
            run.failed = true
            fail(err)
          }
        }
      })
    }
    const made = cutOff(stopping)
    for (const item of stopping) endLater(item.storm, `${item.storm.label} stopped`, made[item.storm.id])
    report(run, null, true)
    // Once what was on screen has reached the engine, count what it shows went dark too.
    void Promise.race([queue.current, wait(SETTLE_MS)]).then(async () => {
      if (!current()) return
      const after = await fetchCampus()
      if (current() && after) report(run, after, true)
    })
  }, [clearRun, cutOff, endLater, enqueue, fail, probe, report])

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
        // The rest of a double or triple click drops nothing more on the same spot.
        const now = performance.now()
        const prev = lastDrop.current
        if (prev && prev.kind === kind && now - prev.at < REPEAT_MS && Math.hypot(press.x - prev.x, press.y - prev.y) < CLICK_PX * 2) {
          prev.at = now
          return
        }
        lastDrop.current = { kind, x: press.x, y: press.y, at: now }
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
      // preventDefault keeps focus where it was. Let go of the dock button, or its tooltip stays up over the map.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
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

  // With nothing armed, a press on a planned storm's path or centre grabs it and a drag moves it.
  // A plain click anywhere inside its footprint selects it. Every other drag pans the map,
  // so a big storm can never trap the view; a plain click on empty map clears the selection.
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
    /** The topmost planned storm whose footprint covers a point: the last one in the plan wins. */
    const inside = (at: LngLat): StormEvent | null => {
      const events = planRef.current.events
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e.type === 'storm' && distPointPath(at, e.path) <= radiusOf(e.kind, e.level)) return e
      }
      return null
    }
    /** Screen pixels per meter here, east-west. */
    const scaleAt = (at: LngLat) => {
      const a = map.project(at)
      const b = map.project([at[0] + 100 / (Math.cos((at[1] * Math.PI) / 180) * 111_320), at[1]])
      return Math.hypot(b.x - a.x, b.y - a.y) / 100
    }
    /** The topmost planned storm a press here grabs: near its path or centre, or anywhere in one drawn small. */
    const grab = (xy: [number, number]): StormEvent | null => {
      const events = planRef.current.events
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e.type !== 'storm') continue
        const pts = e.path.map((p) => map.project(p))
        const reach = Math.max(GRAB_PX, Math.min(radiusOf(e.kind, e.level) * scaleAt(e.path[0]), GRAB_MAX_PX))
        if (screenDistance(xy, pts) <= reach) return e
      }
      return null
    }

    let drag: {
      id: string
      pointer: number
      x: number
      y: number
      at: LngLat
      path: LngLat[]
      moved: number
      dragPan: boolean
      /** The plan before the drag, for Escape. */
      events: ScenarioEvent[]
      version: number
    } | null = null
    let blank: { pointer: number; x: number; y: number; pick: string | null } | null = null
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
      const target = grab([x, y])
      if (!target) {
        // The map pans as usual. Let go without moving and the storm under it, if any, is selected.
        blank = { pointer: e.pointerId, x, y, pick: inside(at)?.id ?? null }
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
      drag = { id: target.id, pointer: e.pointerId, x, y, at, path: target.path, moved: 0, dragPan, events: planRef.current.events, version: versionRef.current }
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
        setCursor(!pending.onSurface ? null : grab(pending.xy) ? 'grab' : inside(toLngLat(pending.xy)) ? 'pointer' : null)
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
        if (Math.hypot(x - blank.x, y - blank.y) < CLICK_PX) {
          if (blank.pick) select(blank.pick)
          else if (selectedRef.current) select(null)
        }
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
    // Escape mid-drag puts the storm back where it was and lets go of it. Ahead of the dock and the
    // map's own Escape, so the storm stays picked and its popover stays open.
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !drag) return
      e.preventDefault()
      e.stopPropagation()
      if (drag.moved >= CLICK_PX) restorePlan(drag.events, drag.version)
      endDrag()
      swallowClick = true
      setCursor(null)
    }

    box.addEventListener('pointerdown', down, true)
    box.addEventListener('pointermove', move)
    box.addEventListener('pointerup', up)
    box.addEventListener('pointercancel', cancel)
    box.addEventListener('pointerleave', leave)
    box.addEventListener('click', click, true)
    window.addEventListener('keydown', key, true)
    return () => {
      box.removeEventListener('pointerdown', down, true)
      box.removeEventListener('pointermove', move)
      box.removeEventListener('pointerup', up)
      box.removeEventListener('pointercancel', cancel)
      box.removeEventListener('pointerleave', leave)
      box.removeEventListener('click', click, true)
      window.removeEventListener('keydown', key, true)
      if (frame) cancelAnimationFrame(frame)
      endDrag()
      box.style.cursor = base
    }
  }, [map, picking, movePath, restorePlan, select])

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
      // The dock already handled it, e.g. Delete on a focused plan row, or the map is hidden behind the grid view.
      if (e.defaultPrevented || optsRef.current.active === false) return
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
        // Only while the plan is on screen to edit: not mid-run, not with the dock folded away, not from another menu.
        if (!id || pressRef.current || runningRef.current || !openRef.current) return
        if (target?.closest('[role="menu"], [aria-haspopup="menu"]')) return
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

  // The engine stopped showing storms it had on record. A reset clears everything;
  // otherwise ask it directly, since a poll sent before a storm started can arrive after it.
  const checking = useRef(false)
  useEffect(() => {
    if (!base) return
    if (degradedRef.current) markDegraded(false)
    const ids = new Set(base.storms.map((s) => s.id))
    const missing = [...confirmed.current].filter((id) => !ids.has(id))
    for (const id of ids) if (!retiredRef.current.has(id)) confirmed.current.add(id)
    if (missing.length === 0 || checking.current) return
    checking.current = true
    void (async () => {
      try {
        if (await probe()) return
        const now = await fetchStorms().catch(() => null)
        if (!now) return
        const still = new Set(now.storms.map((s) => s.id))
        const gone = new Set(missing.filter((id) => !still.has(id) && confirmed.current.has(id)))
        if (gone.size === 0) return
        for (const id of gone) confirmed.current.delete(id)
        // A full record lets its oldest storms go. That is not a reset, and a run playing now goes on.
        if (now.storms.length >= MAX_STORMS) return
        forget(gone)
      } finally {
        checking.current = false
      }
    })()
  }, [base, forget, markDegraded, probe])

  // Look for a reset while a run plays, and while the browser holds weather the engine has no record of.
  const watching = running || (degraded && hasWeather(local))
  useEffect(() => {
    if (!watching) return
    // Start from a fresh look, so a reset from before is not taken for a new one.
    const w = watch.current
    w.gen++
    w.pending = null
    w.mark = null
    void probe()
    const timer = window.setInterval(() => void probe(), WATCH_MS)
    return () => window.clearInterval(timer)
  }, [watching, probe])

  // The sim just polled, e.g. right after the reset button: look now rather than at the next interval.
  const nodes = o.nodes
  useEffect(() => {
    if (watching && performance.now() - watch.current.at > WATCH_MS / 3) void probe()
  }, [nodes, watching, probe])

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
      tracks: effective.storms.flatMap((s) => {
        if (liveIds.has(s.id)) return []
        const cut = cuts[s.id]
        return [cut ? { ...s, path: cut.path, radius: cut.radius } : s]
      }),
      live,
      draft,
      hover,
      marks,
      staged,
      selectedId,
      campus,
      startsAt: plan.startsAt,
    }
  }, [effective, live, cuts, draft, hover, marks, staged, selectedId, campus, plan.startsAt])

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
      error: error?.text ?? null,
      errorDetail: error?.detail ?? null,
      settling,
      startsAt: plan.startsAt,
      onStartsAt,
      ready: map !== null,
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
      settling,
      onStartsAt,
      map,
    ],
  )

  return { armed, effective, canvas, dock, hazards: runHazards, toggleRoute, clear }
}

// ---------------------------------------------------------------------------

/** Pixels from a screen point to a projected path. */
function screenDistance(xy: [number, number], pts: readonly { x: number; y: number }[]): number {
  if (pts.length === 1) return Math.hypot(xy[0] - pts[0].x, xy[1] - pts[0].y)
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = dx * dx + dy * dy
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((xy[0] - a.x) * dx + (xy[1] - a.y) * dy) / len))
    best = Math.min(best, Math.hypot(xy[0] - (a.x + t * dx), xy[1] - (a.y + t * dy)))
  }
  return best
}

/** How far a running storm has got by `now`: the ground it has crossed, or for one in place, how big it has grown. */
function cutAt(l: LiveStorm, now: number): StormCut {
  const s = l.storm
  const progress = Math.max(0, Math.min(1, (now - l.startedAt) / Math.max(1, l.duration)))
  if (s.kind === 'lightning') return { path: progress >= STRIKE ? s.path : [], radius: s.radius }
  if (s.path.length < 2) {
    const radius = growRadius(s.radius, progress)
    return { path: radius >= 1 ? s.path : [], radius: Math.max(1, radius) }
  }
  const cum = cumulative(s.path)
  const along = headFraction(progress) * cum[cum.length - 1]
  return { path: along >= 1 ? slicePath(s.path, along, cum) : [], radius: s.radius }
}

function hasWeather(w: WeatherState): boolean {
  return w.storms.length > 0 || w.closed_routes.length > 0 || w.cut_edges.length > 0 || w.closed_roads.length > 0
}

/** The campus with exactly these nodes down. */
function withDown(nodes: readonly SimNode[], down: ReadonlySet<string>): SimNode[] {
  return nodes.map((node) => (node.failed === down.has(node.id) ? node : { ...node, failed: down.has(node.id) }))
}

/** Weather without one storm and what it closed or cut. */
function dropStorm(w: WeatherState, stormId: string): WeatherState {
  return {
    storms: w.storms.filter((s) => s.id !== stormId),
    closed_routes: w.closed_routes.filter((r) => r.storm_id !== stormId),
    cut_edges: w.cut_edges.filter((e) => e.storm_id !== stormId),
    closed_roads: w.closed_roads.filter((e) => e.storm_id !== stormId),
  }
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * What a run did. With the campus read before and after, buildings dark and feeds cut back
 * come from the engine, so they match the zone bars, load shed after a condition included.
 * Lines, bus lines and roads come from what landed. Conditions also come back as their own
 * short lines, e.g. "both feeds at 70%".
 */
function outcomeOf(landed: readonly Impact[], before: CampusMark | null, after: CampusMark | null): { counts: ImpactCounts; conditions: string[] } {
  const conditions = [...new Set(landed.filter((i) => i.key.startsWith('hazard:')).map((i) => i.detail))]
  const counts = countImpacts(landed)
  if (!before || !after) return { counts, conditions }
  const since = (now: Set<string>, then: Set<string>) => [...now].filter((id) => !then.has(id)).length
  return { counts: { ...counts, buildings: since(after.dark, before.dark), feeds: since(after.derated, before.derated) }, conditions }
}

/** The short detail for the scenario strip when a whole run ends. A condition says what it did; its feeds are not counted again. */
function describe(counts: ImpactCounts, conditions: readonly string[]): string {
  const parts = [...conditions, ...tally(counts, conditions.length === 0)]
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
  const buses = batch.filter((impact) => impact.target === 'bus')
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
    // Road closures, and bus lines closing together, are folded into one line below so they don't crowd the agents out of the short feed.
    if (impact.target === 'road' || (impact.target === 'bus' && buses.length > BUS_LINES_EACH)) continue
    const line = hitLine(storm, impact, nameOf)
    if (!hit.lines.includes(line)) hit.lines.push(line)
  }
  if (buses.length > BUS_LINES_EACH) hit.lines.push(busesLine(storm, buses))
  const roads = batch.filter((impact) => impact.target === 'road')
  if (roads.length === 1) hit.lines.push(hitLine(storm, roads[0], nameOf))
  else if (roads.length > 1) hit.lines.push(`${roads.length} campus roads closed (${roads[0].detail}). Transit routes around them`)
  hit.fail = [...fail]
  return hit
}

/** Two batches of hits for one storm as one write. */
function mergeHits(a: StormHit, b: StormHit): StormHit {
  return {
    storm_id: a.storm_id,
    fail: [...new Set([...a.fail, ...b.fail])],
    derate: [...a.derate, ...b.derate],
    cut_edges: [...a.cut_edges, ...b.cut_edges],
    close_roads: [...a.close_roads, ...b.close_roads],
    close_routes: [...a.close_routes, ...b.close_routes],
    lines: [...a.lines, ...b.lines.filter((line) => !a.lines.includes(line))],
  }
}

/** "6 bus lines closed near the track (snow): Commuter North, Bursley-Baits, Diag-to-Diag and 3 more" */
function busesLine(storm: Storm, buses: readonly Impact[]): string {
  const names = [...new Set(buses.map((impact) => impact.label))]
  const shown = names.slice(0, BUS_LINES_EACH).join(', ')
  const more = names.length - BUS_LINES_EACH
  const why = storm.kind === 'closure' ? 'by the director' : `${storm.path.length > 1 ? 'near the track' : 'in the storm'} (${buses[0].detail})`
  return `${plural(names.length, 'bus line', 'bus lines')} closed ${why}: ${shown}${more > 0 ? ` and ${more} more` : ''}`
}

/** Apply a batch through /disrupt, while `current` holds. True when the engine was written. */
async function viaDisrupt(hit: StormHit, label: string, current: () => boolean): Promise<boolean> {
  const reason = hit.lines.length === 1 ? hit.lines[0] : label
  let wrote = false
  if (hit.fail.length > 0) {
    await disrupt(hit.fail, 'fail', reason)
    wrote = true
  }
  const byFactor = new Map<number, string[]>()
  for (const d of hit.derate) {
    if (hit.fail.includes(d.node_id)) continue
    byFactor.set(d.factor, [...(byFactor.get(d.factor) ?? []), d.node_id])
  }
  for (const [factor, ids] of byFactor) {
    if (!current()) break
    await disrupt(ids, 'derate', reason, factor)
    wrote = true
  }
  return wrote
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

/** "EF3 tornado touched down near Markley Hall, heading north-east for 2.1 km". A path too short to matter reads as in place. */
function headline(storm: Storm): string {
  const start = storm.path[0]
  const { km, heading } = travel(storm.path)
  const moving = km > 0
  const length = `${km.toFixed(1)} km`
  if (storm.kind === 'lightning') {
    const who = ['Lightning', 'Strong lightning', 'A superbolt'][storm.level] ?? 'Lightning'
    return `${who} struck ${where(start, 'near')}`
  }
  const [verb, preposition] = moving ? OPENING[storm.kind].path : OPENING[storm.kind].point
  const tool = storm.kind === 'blackout' || storm.kind === 'closure'
  let tail = ''
  if (moving && tool) tail = heading ? `, along ${length} to the ${heading}` : `, along ${length}`
  else if (moving) tail = heading ? `, heading ${heading} for ${length}` : `, circling for ${length}`
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

/** "3 buildings dark", "1 line down": one part per kind of damage, in a fixed order. Same counts as the dock. */
function tally(c: ImpactCounts, feeds = true): string[] {
  return [
    c.buildings > 0 && `${plural(c.buildings, 'building', 'buildings')} dark`,
    feeds && c.feeds > 0 && `${plural(c.feeds, 'feed', 'feeds')} derated`,
    c.lines > 0 && `${plural(c.lines, 'line', 'lines')} down`,
    c.buses > 0 && `${plural(c.buses, 'bus line', 'bus lines')} closed`,
    c.roads > 0 && `${plural(c.roads, 'road', 'roads')} closed`,
  ].filter((part): part is string => Boolean(part))
}

/** The feed line when a storm ends. */
function summarize(storm: Storm, impacts: readonly Impact[]): { line: string } {
  const parts = tally(countImpacts(impacts))
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

/** What went wrong in plain words, with the engine's own words kept for a tooltip. */
function message(err: unknown): { text: string; detail?: string } {
  if (err instanceof TypeError) return { text: 'Engine unreachable. Hits are kept on the map only.' }
  if (err instanceof NoStormRoutes) return { text: err.message }
  const detail = err instanceof Error ? err.message : String(err)
  return { text: 'The engine didn’t take part of the plan. Try again.', detail }
}
