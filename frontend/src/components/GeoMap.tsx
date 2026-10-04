import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import { Map, Marker, NavigationControl } from '@vis.gl/react-maplibre'
import { setWorkerUrl, type ExpressionSpecification, type Map as MaplibreMap } from 'maplibre-gl'
import type { Feature, FeatureCollection, GeoJsonProperties, LineString } from 'geojson'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Briefing, ClassSpot, LocationSurvey, ProposalPin } from '../lib/api'
import type { ClassClock } from '../lib/classLoad'
import type { SurveyGraphModel } from '../lib/surveyGraph'
import { BACKEND_URL } from '../config'
import { CAMPUSES, MAP_STYLE, PLACES, VECTOR_STYLE } from '../lib/places'
import type { SimEdge, SimNode } from '../lib/sim'
import { splitByClosures } from '../lib/weather/geo'
import { TICK_MINUTES, type BusLine, type ClosedRoute, type LngLat, type WeatherRequest, type WeatherState } from '../lib/weather/types'
import type { PlannedScenario } from '../lib/weather/forecast'
import { useWeather, type StormNote } from './weather/useWeather'
import { WeatherCanvas } from './weather/WeatherCanvas'
import { WeatherDock } from './weather/WeatherDock'

setWorkerUrl(maplibreWorkerUrl)
import { statusColor } from '../lib/status'

interface BusFeature {
  type: 'Feature'
  properties: { id: string; name: string; agency: string; direction: string; near: string[] }
  geometry: { type: 'LineString'; coordinates: [number, number][] }
}

interface BusCollection {
  type: 'FeatureCollection'
  features: BusFeature[]
}

const EMPTY: BusCollection = { type: 'FeatureCollection', features: [] }

/** 2D raster opens first: it loads fast and is the path storm closures are tested on. The layer panel turns 3D on. */
const DEFAULT_3D = false

/** The app theme, from the landing page's saved choice or the system. */
function appDark(): boolean {
  const theme = document.documentElement.dataset.theme
  if (theme) return theme === 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Core U-M lines between the campuses. The full list does not change when a building fails. */
const USUAL_RECOMMENDED = new Set(['CN', 'CS', 'BB', 'NW'])

const UMICH = CAMPUSES.find((item) => item.id === 'umich') ?? CAMPUSES[0]

/** City buildings are off this map. The view is the university. */
const CITY = new Set(['city_hall', 'blake', 'fire_1'])

/** Distinct colors so two lines that share a street can still be told apart. */
const ROUTE_COLORS: Record<string, string> = {
  BB: '#4ade80',
  CN: '#38bdf8',
  CS: '#2563eb',
  CSX: '#a78bfa',
  DD: '#facc15',
  MX: '#f97316',
  NES: '#84cc16',
  NW: '#fb7185',
  NX: '#e11d48',
  OS: '#67e8f9',
  WS: '#c4b5fd',
  WX: '#d946ef',
  '3': '#f472b6',
  '4': '#fbbf24',
  '5': '#2dd4bf',
  '6': '#818cf8',
  '22': '#22d3ee',
  '23': '#a3e635',
  '62': '#fb923c',
  '63': '#f43f5e',
  '64': '#94a3b8',
  '65': '#34d399',
  '66': '#60a5fa',
}

function routeColor(id: string): string {
  return ROUTE_COLORS[id] ?? '#e2e8f0'
}

/** What App can ask of the map from outside. */
export interface GeoMapHandle {
  /** Stop a running scenario and forget weather kept in the browser. Call before a campus reset. */
  clearWeather: () => void
  /** The scenario plan as timed batches for Branch, or null when there is nothing new to play. */
  plannedScenario: () => PlannedScenario | null
  /** Play the dock's plan on the live campus, as its Run button does. */
  runPlan: () => void
}

/** Weather on the map, for the scenario strip. */
export interface WeatherStatus {
  /** Storms, closures or cut lines are on the map. */
  active: boolean
  /** A scenario is playing. */
  running: boolean
  /**
   * What the run playing now, or the last one, is made of, in plan order: engine ids
   * of its campus-wide conditions, and "storm:<kind>" for weather drawn on the map.
   */
  hazards: string[]
  /** The dock has a plan the last run has not already played. */
  planned?: boolean
  /** The plan's start time and run speed, for the one sim clock. */
  startsAt?: string
  speed?: number
}

interface Props {
  ref?: Ref<GeoMapHandle>
  /** The map view is showing. It stays mounted behind the grid view so a run keeps going. */
  active?: boolean
  nodes: readonly SimNode[]
  edges: readonly SimEdge[]
  selectedId?: string | null
  coolingIds?: readonly string[]
  shelterKind?: 'cooling' | 'warming'
  useRouteIds?: readonly string[]
  reroutes?: Briefing['buses']['reroute']
  survey?: LocationSurvey | null
  surveyGraph?: SurveyGraphModel | null
  surveyDark?: ReadonlySet<string>
  onToggleSurvey?: (id: string) => void
  placing?: boolean
  proposals?: readonly ProposalPin[]
  draftPoint?: { lng: number; lat: number; name: string } | null
  onPlace?: (lng: number, lat: number) => void
  onNodeClick?: (node: SimNode) => void
  /** briefing.weather from the engine. */
  weather?: WeatherState | null
  /** Open the scenario dock, and arm a kind or add a condition or fault, once per seq. */
  weatherRequest?: WeatherRequest | null
  /** A scenario finished its run. */
  onStorm?: (storm: StormNote) => void
  /** Weather appeared or cleared, or a run started or stopped. */
  onWeatherStatus?: (status: WeatherStatus) => void
  /** Pull engine state after a write. */
  onChanged?: () => void
  /** Students in class by building at the chosen time. */
  classSpots?: readonly ClassSpot[]
  classClock?: ClassClock | null
  onClassSlot?: (slot: number) => void
  /** Minute of the day on a running scenario's clock, every second; null when the run ends. */
  onClassTime?: (minutes: number | null) => void
  /** The campus picker or a school marker moved the map to another campus. */
  onCampusChange?: () => void
}

export function GeoMap({
  ref,
  active = true,
  nodes,
  edges,
  selectedId,
  coolingIds = [],
  shelterKind = 'warming',
  useRouteIds = [],
  survey = null,
  surveyGraph = null,
  surveyDark,
  onToggleSurvey,
  placing = false,
  proposals = [],
  draftPoint = null,
  onPlace,
  onNodeClick,
  weather = null,
  weatherRequest = null,
  onStorm,
  onWeatherStatus,
  onChanged,
  classSpots = [],
  classClock = null,
  onClassSlot,
  onClassTime,
  onCampusChange,
}: Props) {
  const [map, setMap] = useState<MaplibreMap | null>(null)
  const [buses, setBuses] = useState<BusCollection>(EMPTY)
  const [showPower, setShowPower] = useState(true)
  const [showRoads, setShowRoads] = useState(false)
  const [showBuses, setShowBuses] = useState(true)
  const [showRecommended, setShowRecommended] = useState(true)
  const [showMotion, setShowMotion] = useState(true)
  const [showCampusPower, setShowCampusPower] = useState(true)
  const [showCampusLandmarks, setShowCampusLandmarks] = useState(true)
  const [threeD, setThreeD] = useState(DEFAULT_3D)
  // The map follows the app theme; the Night map toggle overrides it until the theme changes again.
  const [mapTheme, setMapTheme] = useState<'day' | 'night'>(() => (appDark() ? 'night' : 'day'))
  const mapThemeRef = useRef(mapTheme)
  const [basemap, setBasemap] = useState<'raster' | 'vector'>('raster')
  const dayPaintValues = useRef(new globalThis.Map<string, string | ExpressionSpecification>())
  const [campusId, setCampusId] = useState<(typeof CAMPUSES)[number]['id']>('umich')
  const keepCameraOnAutomaticCampusChange = useRef(false)
  const [campusOverview, setCampusOverview] = useState(false)
  const [showSchoolMarkers, setShowSchoolMarkers] = useState(false)
  const [zoomLevel, setZoomLevel] = useState(14)
  // While the basemap switches the map is blank, so weather drawn on it would float on nothing.
  const [restyling, setRestyling] = useState(false)
  const [styledFor, setStyledFor] = useState(threeD)
  if (styledFor !== threeD) {
    setStyledFor(threeD)
    setRestyling(true)
  }
  useEffect(() => {
    if (!restyling) return
    const timer = window.setTimeout(() => setRestyling(false), 3000)
    return () => window.clearTimeout(timer)
  }, [restyling])
  const [focus, setFocus] = useState<string | null>(null)
  const campusChangeRef = useRef(onCampusChange)
  const surveyRef = useRef(survey)
  useEffect(() => {
    campusChangeRef.current = onCampusChange
    surveyRef.current = survey
  })
  const [showLayerPanel, setShowLayerPanel] = useState(true)
  const [showBusPanel, setShowBusPanel] = useState(true)
  const campus = CAMPUSES.find((item) => item.id === campusId) ?? CAMPUSES[0]
  const isUmich = campusId === 'umich'
  // U-M at campus scale: the only place the simulation and its weather run.
  const onCampus = isUmich && !campusOverview
  const [mapOpacity, setMapOpacity] = useState(1)

  // Class load: circles sized by students in class, on the U-M map only.
  const [showPeople, setShowPeople] = useState(true)
  const peopleOn = showPeople && onCampus && !survey
  const visibleClasses = useMemo(
    () => (peopleOn ? classSpots.filter((spot) => spot.students > 0 && inTown(spot.lng, spot.lat)) : []),
    [classSpots, peopleOn],
  )
  const classMax = classClock?.dayPeak || visibleClasses.reduce((max, spot) => Math.max(max, spot.students), 0)
  const classByNode = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const spot of visibleClasses) if (spot.nodeId) counts[spot.nodeId] = (counts[spot.nodeId] ?? 0) + spot.students
    return counts
  }, [visibleClasses])
  // Only the busiest few carry a label. Buildings with a sim pin show their count on the pin instead.
  const labeledClasses = useMemo(
    () => new Set([...visibleClasses].filter((spot) => !spot.nodeId).sort((a, b) => b.students - a.students).slice(0, 6).map((spot) => spot.code)),
    [visibleClasses],
  )
  const darkNodes = useMemo(() => new Set(nodes.filter((n) => n.status === 'Red').map((n) => n.id)), [nodes])

  useEffect(() => {
    let stop = false
    fetch(`${BACKEND_URL}/bus-routes`)
      .then((res) => (res.ok ? res.json() : EMPTY))
      .then((data: BusCollection) => {
        if (!stop) {
          setBuses({
            ...data,
            features: data.features.filter((feature) => feature.properties.agency === 'U-M'),
          })
        }
      })
      .catch(() => {})
    return () => {
      stop = true
    }
  }, [])

  const allPower = useMemo(() => links(edges, 'power'), [edges])
  const allRoads = useMemo(() => links(edges, 'road'), [edges])

  const busLines = useMemo<BusLine[]>(
    () => buses.features.map((f) => ({ id: f.properties.id, name: f.properties.name, coords: f.geometry.coordinates })),
    [buses],
  )
  const storm = useWeather({
    map,
    active,
    nodes,
    edges,
    proposals,
    buses: busLines,
    server: weather,
    request: weatherRequest,
    onChanged: () => onChanged?.(),
    onStorm,
  })
  const { closed_routes: closedRoutes, cut_edges: cutEdges, closed_roads: closedRoads } = storm.effective

  // The class circles follow a running scenario's clock, the same one the dock shows.
  const run = storm.dock.run
  const runSpeed = storm.dock.speed
  const runStart = storm.dock.startsAt
  useEffect(() => {
    if (!run || !onClassTime) return
    const [h, m] = (runStart ?? '14:00').split(':').map(Number)
    const start = (Number.isFinite(h) ? h : 14) * 60 + (Number.isFinite(m) ? m : 0)
    const tick = () => {
      const total = (run.total / 1000) * runSpeed
      const seconds = Math.min(total, (Math.max(0, performance.now() - run.startedAt) / 1000) * runSpeed)
      onClassTime((start + Math.floor(seconds * TICK_MINUTES)) % 1440)
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => {
      window.clearInterval(timer)
      onClassTime(null)
    }
  }, [run, runSpeed, runStart, onClassTime])

  const clearWeather = storm.clear
  const plannedScenario = storm.planned
  const runPlan = storm.dock.onRun
  useImperativeHandle(ref, () => ({ clearWeather, plannedScenario, runPlan }), [clearWeather, plannedScenario, runPlan])

  const weatherActive = storm.effective.storms.length + closedRoutes.length + cutEdges.length + closedRoads.length > 0
  const running = storm.dock.phase === 'running'
  const hazardKey = storm.hazards.join(',')
  const statusRef = useRef(onWeatherStatus)
  useEffect(() => {
    statusRef.current = onWeatherStatus
  })
  useEffect(() => {
    statusRef.current?.({
      active: weatherActive,
      running,
      hazards: hazardKey ? hazardKey.split(',') : [],
      planned: storm.plannable,
      startsAt: storm.dock.startsAt,
      speed: storm.dock.speed,
    })
  }, [weatherActive, running, hazardKey, storm.plannable, storm.dock.startsAt, storm.dock.speed])

  // Back from the grid view: the container may have changed size while hidden.
  useEffect(() => {
    if (!map || !active) return
    const frame = requestAnimationFrame(() => map.resize())
    return () => cancelAnimationFrame(frame)
  }, [map, active])

  // Placing a planned building owns map clicks. Fold the dock away until the pin is down.
  const dockOpen = storm.dock.open
  const dockRef = useRef(storm.dock)
  const reopenDock = useRef(false)
  useEffect(() => {
    dockRef.current = storm.dock
  })
  useEffect(() => {
    const dock = dockRef.current
    if (placing && dock.open) {
      reopenDock.current = true
      dock.onOpen(false)
    } else if (!placing && reopenDock.current) {
      reopenDock.current = false
      dock.onOpen(true)
    }
  }, [placing])
  useEffect(() => {
    if (placing && storm.armed) dockRef.current.onKind(null)
  }, [placing, storm.armed])
  const armed = storm.armed && !placing

  // Lasting marks follow their layer: no bolt over a hidden power line, no X over a hidden bus line.
  const busesShown = showBuses || showRecommended
  const marks = useMemo(
    () => storm.canvas.marks.filter((mark) => (mark.kind === 'line' ? showPower : mark.kind === 'bus' ? busesShown : showRoads)),
    [storm.canvas.marks, showPower, busesShown, showRoads],
  )

  // The bus legend shares the left edge with the open dock. Keep it between the layer toggles and the dock.
  const rootRef = useRef<HTMLDivElement>(null)
  const togglesRef = useRef<HTMLDivElement>(null)
  const dockBox = useRef<HTMLDivElement>(null)
  const [legendRoom, setLegendRoom] = useState<{ top: number; height: number } | null>(null)
  // With the dock folded the legend sits at the bottom, and may grow up to the layer toggles.
  const [legendMax, setLegendMax] = useState<number | null>(null)
  useLayoutEffect(() => {
    const root = rootRef.current
    const toggles = togglesRef.current
    const dock = dockOpen ? dockBox.current?.firstElementChild : null
    if (!root || !toggles) return
    const measure = () => {
      const box = root.getBoundingClientRect()
      const top = toggles.getBoundingClientRect().bottom - box.top + 8
      setLegendMax(Math.max(72, Math.floor(box.height - 28 - top)))
      if (!(dock instanceof HTMLElement)) {
        setLegendRoom(null)
        return
      }
      const shell = dock.getBoundingClientRect()
      // 16px inset plus the 240px legend, and a little air.
      const under = shell.left - box.left < 16 + 240 + 12
      const bottom = under ? shell.top - box.top - 12 : box.height - 32
      setLegendRoom({ top, height: Math.floor(bottom - top) })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    observer.observe(toggles)
    if (dock instanceof HTMLElement) observer.observe(dock)
    return () => observer.disconnect()
  }, [dockOpen, showLayerPanel, onCampus])

  // A legend taller than its room scrolls; fade its bottom edge so a cut row reads as more below, not a glitch.
  const legendRef = useRef<HTMLDivElement>(null)
  const [legendMore, setLegendMore] = useState(false)
  useLayoutEffect(() => {
    const el = legendRef.current
    if (!el) return
    const update = () => setLegendMore(el.scrollTop + el.clientHeight < el.scrollHeight - 2)
    update()
    el.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      observer.disconnect()
    }
  })

  // Storms are drawn at campus scale. Opening the dock from the city view moves in to campus.
  // Opened from another campus or the national view, go home to U-M first.
  const awayRef = useRef({ campusId, campusOverview })
  useEffect(() => {
    awayRef.current = { campusId, campusOverview }
  })
  useEffect(() => {
    if (!map || !dockOpen || survey) return
    const away = awayRef.current
    if (away.campusId !== 'umich' || away.campusOverview) {
      setCampusId('umich')
      if (away.campusOverview) map.easeTo({ center: UMICH.center, zoom: UMICH.zoom, pitch: 0, bearing: 0, duration: 900 })
      return
    }
    if (map.getZoom() >= 13) return
    map.easeTo({ center: [-83.728, 42.2845], zoom: 13.5, duration: 700 })
  }, [map, dockOpen, survey])
  // Leaving U-M folds the dock; it is hidden there and would reopen over the next campus.
  useEffect(() => {
    if (!onCampus && dockRef.current.open) dockRef.current.onOpen(false)
  }, [onCampus])

  // Weather takes lines and roads out. They stay on the map, drawn as broken.
  const [power, cutPower] = useMemo(() => splitLinks(allPower, new Set(cutEdges.map((m) => m.id))), [allPower, cutEdges])
  const [roads, shutRoads] = useMemo(() => splitLinks(allRoads, new Set(closedRoads.map((m) => m.id))), [allRoads, closedRoads])
  const closedLines = useMemo(() => {
    const out: Record<string, 'suspended' | 'closed'> = {}
    for (const route of closedRoutes) out[route.id] = route.segments === null || out[route.id] === 'suspended' ? 'suspended' : 'closed'
    return out
  }, [closedRoutes])

  const recommendedIds = USUAL_RECOMMENDED

  const recommended = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: buses.features.filter((feature) => recommendedIds.has(feature.properties.id)),
    }),
    [buses, recommendedIds],
  )

  const darkPlaces = useMemo(() => {
    const places: Record<string, { lng: number; lat: number }> = {}
    for (const node of nodes) {
      const place = PLACES[node.id]
      if (node.status === 'Red' && place && !CITY.has(node.id)) places[node.id] = place
    }
    return places
  }, [nodes])

  const catalog = useMemo(() => {
    const picked: Record<string, BusFeature> = {}
    const source = [
      ...(showBuses ? buses.features : []),
      ...(showRecommended ? recommended.features : []),
    ]
    for (const feature of source) {
      const id = feature.properties.id
      const existing = picked[id]
      if (!existing || feature.geometry.coordinates.length > existing.geometry.coordinates.length) {
        picked[id] = feature
      }
    }
    return Object.values(picked).map((feature) => {
      const closed = feature.properties.near.some((id) => darkPlaces[id])
      return {
        ...feature,
        properties: {
          ...feature.properties,
          color: routeColor(feature.properties.id),
          dashed: closed,
          skipped: false,
          ...(useRouteIds.length > 0 ? { useful: useRouteIds.includes(feature.properties.id) } : {}),
        },
      }
    })
  }, [buses, recommended, showBuses, showRecommended, darkPlaces, useRouteIds])

  const drawnBuses = useMemo(
    () =>
      catalog
        .flatMap((feature) => closeForWeather(feature, closedRoutes))
        .flatMap((feature) => (feature.properties.skipped ? [feature] : openAroundDarkStops(feature, darkPlaces))),
    [catalog, darkPlaces, closedRoutes],
  )

  const legendShort = legendRoom !== null && legendRoom.height < 72
  // Buses run only on open stretches: a suspended line has none, a storm-closed or dark-stop stretch is skipped.
  const motionRoutes = useMemo(() => {
    const full = new globalThis.Map(catalog.map((feature) => [feature.properties.id, lineMeters(feature.geometry.coordinates)]))
    return drawnBuses.flatMap((feature, index) => {
      const coordinates = feature.geometry.coordinates
      if (feature.properties.skipped || coordinates.length < 2) return []
      const share = lineMeters(coordinates) / (full.get(feature.properties.id) || 1)
      if (share < 0.04) return []
      return [{
        id: `${feature.properties.id}#${index}`,
        name: feature.properties.name,
        color: feature.properties.color,
        coordinates,
        share,
      }]
    })
  }, [catalog, drawnBuses])

  const legend = isUmich
    ? catalog
        .map((feature) => feature.properties)
        .sort((a, b) => a.agency.localeCompare(b.agency) || a.name.localeCompare(b.name))
    : campus.routes.map((route) => ({
        id: route.id,
        name: route.name,
        agency: campus.name,
        color: '#38bdf8',
        dashed: false,
        useful: undefined as boolean | undefined,
      }))
  const campusRouteFeatures = campus.routes.map((route) => ({
    type: 'Feature' as const,
    properties: { id: route.id, name: route.name, color: '#38bdf8', dashed: false },
    geometry: { type: 'LineString' as const, coordinates: route.coordinates },
  }))
  const campusPowerFeatures = campus.landmarks.map((landmark, index) => ({
    type: 'Feature' as const,
    properties: { id: `${campus.id}-power-${index}`, color: '#f59e0b', dashed: true },
    geometry: {
      type: 'LineString' as const,
      coordinates: [campus.center, landmark.point],
    },
  }))
  const activeMotionRoutes = useMemo<MotionRoute[]>(
    () => (isUmich ? motionRoutes : campus.routes.map((route) => ({ ...route, color: '#38bdf8' }))),
    [isUmich, motionRoutes, campus],
  )

  function onLoad(event: { target: MaplibreMap }) {
    setMap(event.target)
  }

  // MapLibre shows its attribution on load and folds it once the map moves. The open dock
  // would sit on top of it, so fold it to its (i) button while the dock is up.
  useEffect(() => {
    if (!map || !dockOpen) return
    const attrib = map.getContainer().querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show')
    if (attrib) {
      attrib.classList.remove('maplibregl-compact-show')
      attrib.setAttribute('open', '')
    }
  }, [map, dockOpen])

  // Names of dark buildings in dense spots would land on each other. Move each to a free side of its dot,
  // or, with no side free, fold it away until hovered.
  useEffect(() => {
    if (!map) return
    let frame = 0
    const run = () => {
      frame = 0
      declutter(map.getCanvasContainer())
    }
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(run)
    }
    soon()
    map.on('move', soon)
    map.on('resize', soon)
    return () => {
      map.off('move', soon)
      map.off('resize', soon)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [map, nodes, selectedId, coolingIds, active, visibleClasses])

  useEffect(() => {
    mapThemeRef.current = mapTheme
  }, [mapTheme])

  useEffect(() => {
    const follow = () => setMapTheme(appDark() ? 'night' : 'day')
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const observer = new MutationObserver(follow)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    media.addEventListener('change', follow)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', follow)
    }
  }, [])

  // Inline, so it replaces the theme filter in index.css rather than stacking a second inversion.
  useEffect(() => {
    if (!map) return
    map.getCanvas().style.filter = basemap === 'raster'
      ? mapTheme === 'night'
        ? 'invert(1) hue-rotate(180deg) brightness(0.75) contrast(0.95) saturate(0.6)'
        : 'saturate(0.45) contrast(0.95) brightness(1.02)'
      : ''
  }, [map, basemap, mapTheme])

  useEffect(() => {
    if (!map) return
    const updateOverview = () => {
      const zoom = map.getZoom()
      const next = zoom <= 5.5
      setCampusOverview((current) => current === next ? current : next)
      setShowSchoolMarkers(zoom <= 9.5)
      setZoomLevel(zoom)
    }
    updateOverview()
    map.on('zoom', updateOverview)
    return () => {
      map.off('zoom', updateOverview)
    }
  }, [map])

  useEffect(() => {
    if (!map) return
    const updateCampusFromMapCenter = () => {
      const zoom = map.getZoom()
      // A researched place is shown wherever it is; it does not switch campus.
      if (zoom < 8 || surveyRef.current) return

      const center = map.getCenter()
      const candidates = CAMPUSES.flatMap((school) => {
        const distance = distanceBetweenCoordinatesKm(
          [center.lng, center.lat],
          school.center,
        )
        return distance <= 6 ? [{ school, distance }] : []
      })
      if (candidates.length === 0) return

      const nearestDistance = Math.min(...candidates.map(({ distance }) => distance))
      const priority = (school: (typeof CAMPUSES)[number]) =>
        school.collection === 'featured' ? 3 : school.prominent || school.collection === 'extra' ? 2 : 1
      const contenders = candidates
        .filter(({ distance }) => distance <= nearestDistance + 0.75)
        .sort((a, b) => priority(b.school) - priority(a.school) || a.distance - b.distance)
      let nextCampus = contenders[0]

      const currentCampus = candidates.find(({ school }) => school.id === campusId)
      if (
        currentCampus &&
        priority(currentCampus.school) >= priority(nextCampus.school) &&
        currentCampus.distance <= nextCampus.distance + 0.5
      ) {
        nextCampus = currentCampus
      }

      if (nextCampus.school.id !== campusId) {
        keepCameraOnAutomaticCampusChange.current = true
        setCampusId(nextCampus.school.id)
        campusChangeRef.current?.()
      }
    }

    // Only after a move: checking on every campus change would snap a picked campus back to the one under the old view.
    map.on('moveend', updateCampusFromMapCenter)
    map.on('zoomend', updateCampusFromMapCenter)
    return () => {
      map.off('moveend', updateCampusFromMapCenter)
      map.off('zoomend', updateCampusFromMapCenter)
    }
  }, [map, campusId])

  useEffect(() => {
    if (!map || !campusOverview) return
    const longitudes = CAMPUSES.map((item) => item.center[0])
    const latitudes = CAMPUSES.map((item) => item.center[1])
    map.fitBounds(
      [
        [Math.min(...longitudes), Math.min(...latitudes)],
        [Math.max(...longitudes), Math.max(...latitudes)],
      ],
      { padding: 48, duration: 700, maxZoom: 4.5 },
    )
  }, [map, campusOverview])

  useEffect(() => {
    if (!map) return
    const apply = () => {
      setRestyling(false)
      const vector = Boolean(map.getSource('openmaptiles'))
      setBasemap(vector ? 'vector' : 'raster')
      if (threeD && vector) {
        addBuildings(map, mapThemeRef.current)
        applyMapTheme(map, mapThemeRef.current, dayPaintValues.current)
      }
      if (keepCameraOnAutomaticCampusChange.current) {
        keepCameraOnAutomaticCampusChange.current = false
      } else {
        map.easeTo({
          pitch: threeD && vector ? 60 : 0,
          bearing: threeD && vector ? -24 : 0,
          zoom: campus.zoom,
          center: campus.center,
          duration: 800,
        })
      }
    }
    if (map.isStyleLoaded()) apply()
    map.on('style.load', apply)
    return () => {
      map.off('style.load', apply)
    }
  }, [map, threeD, campus])

  useEffect(() => {
    if (!map || basemap !== 'vector') return
    const apply = () => {
      if (!map.isStyleLoaded()) return
      applyMapTheme(map, mapTheme, dayPaintValues.current)
      if (threeD) addBuildings(map, mapTheme)
    }
    apply()
    map.on('style.load', apply)
    return () => {
      map.off('style.load', apply)
    }
  }, [map, basemap, mapTheme, threeD])

  // The map stays mounted behind the grid view, so clearing a researched place has to bring the camera home.
  const surveyed = useRef(false)
  const shown = useRef(active)
  useEffect(() => {
    shown.current = active
  }, [active])
  useEffect(() => {
    if (!map) return
    if (!survey) {
      if (!surveyed.current) return
      surveyed.current = false
      const home = { center: [-83.728, 42.286] as [number, number], zoom: 12.4, pitch: 0, bearing: 0 }
      if (shown.current) map.easeTo({ ...home, duration: 800 })
      else map.jumpTo(home)
      return
    }
    surveyed.current = true
    if (survey.buildings.length === 0) return
    const lngs = survey.buildings.map((building) => building.lng)
    const lats = survey.buildings.map((building) => building.lat)
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 72, duration: 800, maxZoom: 15 },
    )
  }, [map, survey])

  // Away from U-M the sim lines are emptied, not left behind from the last visit.
  useEffect(() => {
    if (!map || basemap !== 'vector') return
    const ground = (features: Feature<LineString, GeoJsonProperties>[]) =>
      (onCampus ? features : []).map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          dim: (focus && feature.properties?.id !== focus) || feature.properties?.useful === false,
        },
      }))
    setGroundLines(map, 'sim-roads', ground(showRoads ? roads.features : []), {
      'line-color': '#64748b',
      'line-width': 2,
      'line-dasharray': [2, 1.4],
      'line-opacity': 0.8,
    })
    setGroundLines(map, 'sim-power', ground(showPower ? power.features : []), {
      'line-color': '#c2410c',
      'line-width': 3,
      'line-opacity': 0.9,
    })
    setGroundLines(map, 'sim-power-cut', ground(showPower ? cutPower.features : []), {
      'line-color': '#ef4444',
      'line-width': 2.5,
      'line-dasharray': [1.2, 1.4],
      'line-opacity': 0.95,
    })
    setGroundLines(map, 'sim-roads-shut', ground(showRoads ? shutRoads.features : []), {
      'line-color': '#ef4444',
      'line-width': 2,
      'line-dasharray': [1.2, 1.4],
      'line-opacity': 0.9,
    })
    setGroundLines(
      map,
      'sim-buses',
      ground(drawnBuses.filter((feature) => !feature.properties.skipped)),
      {
        'line-color': ['case', ['==', ['get', 'dim'], true], '#94a3b8', ['coalesce', ['get', 'color'], '#334155']],
        'line-width': ['case', ['==', ['get', 'dim'], true], 1.5, ['==', ['get', 'useful'], true], 5, 3],
        'line-opacity': ['case', ['==', ['get', 'dim'], true], 0.35, 0.95],
      },
    )
    setGroundLines(
      map,
      'sim-bus-gaps',
      ground(drawnBuses.filter((feature) => feature.properties.skipped)),
      {
        'line-color': '#ef4444',
        'line-width': 2.5,
        'line-dasharray': [1.4, 1.2],
        'line-opacity': 0.95,
      },
    )
  }, [map, basemap, showRoads, showPower, roads, power, cutPower, shutRoads, drawnBuses, focus, onCampus])

  // Switch campus, or fly back to this one when it is already picked (e.g. from the national view).
  const openCampus = (id: typeof campusId) => {
    const target = CAMPUSES.find((item) => item.id === id)
    if (id === campusId && map && target) {
      const tilt = threeD && basemap === 'vector'
      map.easeTo({ center: target.center, zoom: target.zoom, pitch: tilt ? 60 : 0, bearing: tilt ? -24 : 0, duration: 800 })
    } else setCampusId(id)
    onCampusChange?.()
  }

  return (
    <div
      ref={rootRef}
      className={`relative h-full ${basemap === 'raster' ? 'map-raster' : 'map-3d'} ${placing ? 'cursor-crosshair' : storm.armed && !map ? 'cursor-progress' : ''}`}
      style={{ ['--map-opacity' as string]: String(mapOpacity) }}
    >
      <label className="absolute right-4 top-3.5 z-10 flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
        Campus
        <select
          aria-label="Select campus"
          value={campusOverview ? '' : campusId}
          onChange={(event) => openCampus(event.target.value as typeof campusId)}
          className="max-w-52 bg-panel text-text outline-none"
        >
          {/* Blank while zoomed out, so picking the current campus still flies back to it. */}
          {campusOverview && <option value="" disabled>National view</option>}
          <optgroup label="Featured campuses">
            {CAMPUSES.filter((item) => item.collection === 'featured').map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </optgroup>
          <optgroup label="Nearby schools">
            {CAMPUSES.filter((item) => item.collection === 'nearby').map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </optgroup>
          <optgroup label="Extra previews · not a verified MHacks invite list">
            {CAMPUSES.filter((item) => item.collection === 'extra').map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </optgroup>
        </select>
      </label>
      {!isUmich && (
        <div className="absolute right-4 top-16 z-10 flex max-w-64 items-center gap-2.5 rounded-lg border border-line bg-panel/95 px-3 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-white p-1">
            {campus.logo && (
              <img
                src={campus.logo}
                alt=""
                onError={(event) => {
                  event.currentTarget.style.display = 'none'
                  event.currentTarget.nextElementSibling?.classList.remove('hidden')
                }}
                className="absolute inset-1 h-[calc(100%-8px)] w-[calc(100%-8px)] object-contain"
              />
            )}
            <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-5 w-5 text-slate-600 ${campus.logo ? 'hidden' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6M8 10h.01M12 10h.01M16 10h.01" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-text">{campus.name}</div>
            <div className="mt-0.5 font-mono text-[9px] uppercase tracking-wide text-muted">
              {campus.landmarks.length} landmarks · {campus.routes.length} illustrative routes
            </div>
            <div className="mt-0.5 text-[9px] text-muted">Preview only · simulation remains U-M</div>
          </div>
        </div>
      )}
      {showLayerPanel ? (
        <div ref={togglesRef} className="absolute left-4 top-3.5 z-10 flex flex-col gap-1.5 rounded-lg border border-line bg-panel px-3 py-2.5 text-xs shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
          <div className="mb-1 flex items-center justify-between gap-5 border-b border-line pb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Map layers</span>
            <button type="button" aria-label="Hide map layers panel" onClick={() => setShowLayerPanel(false)} className="text-sm leading-none text-muted hover:text-text">×</button>
          </div>
          {isUmich && <Toggle label="Power lines" checked={showPower} onChange={setShowPower} />}
          {isUmich && <Toggle label="Road links" checked={showRoads} onChange={setShowRoads} />}
          {isUmich ? (
            <>
              <Toggle label="U-M bus lines" checked={showBuses} onChange={setShowBuses} />
              <Toggle label="Recommended routes" checked={showRecommended} onChange={setShowRecommended} />
              <Toggle label="Moving buses" checked={showMotion} onChange={setShowMotion} />
              <Toggle label="People" checked={showPeople} onChange={setShowPeople} />
            </>
          ) : (
            <>
              <Toggle label="Campus landmarks" checked={showCampusLandmarks} onChange={setShowCampusLandmarks} />
              <Toggle label="Illustrative energy links" checked={showCampusPower} onChange={setShowCampusPower} />
              <Toggle label="Illustrative shuttle routes" checked={showBuses} onChange={setShowBuses} />
              <Toggle label="Illustrative route movement" checked={showMotion} onChange={setShowMotion} />
            </>
          )}
          <Toggle label="3D buildings" checked={threeD} onChange={setThreeD} />
          <Toggle
            label="Night map"
            checked={mapTheme === 'night'}
            onChange={(enabled) => setMapTheme(enabled ? 'night' : 'day')}
          />
          <label className="mt-1 flex items-center gap-2">
            Map
            <input
              type="range"
              min={0.15}
              max={1}
              step={0.05}
              value={mapOpacity}
              onChange={(event) => setMapOpacity(Number(event.target.value))}
              className="w-16"
            />
          </label>
          {isUmich && <p className="text-[10px] text-muted">pink = go here · orange = leave</p>}
        </div>
      ) : (
        <button ref={togglesRef as Ref<HTMLButtonElement>} type="button" onClick={() => setShowLayerPanel(true)} className="absolute left-4 top-3.5 z-10 rounded-md border border-line bg-panel/95 px-3 py-2 text-xs text-text shadow">
          Show map layers
        </button>
      )}
      <Map
        mapStyle={threeD ? VECTOR_STYLE : MAP_STYLE}
        initialViewState={
          threeD
            ? { longitude: campus.center[0], latitude: campus.center[1], zoom: campus.zoom, pitch: 60, bearing: -24 }
            : { longitude: campus.center[0], latitude: campus.center[1], zoom: campus.zoom, pitch: 0 }
        }
        maxPitch={70}
        style={{ width: '100%', height: '100%' }}
        onLoad={onLoad}
        onClick={(event) => {
          if (!isUmich || !placing || !onPlace) return
          onPlace(event.lngLat.lng, event.lngLat.lat)
        }}
        cursor={placing ? 'crosshair' : undefined}
      >
        <NavigationControl position="bottom-right" showCompass />
        {visibleClasses.map((spot) => {
          const share = classMax > 0 ? Math.min(1, spot.students / classMax) : 0
          const size = 14 + Math.sqrt(share) * 52
          const dark = spot.nodeId != null && darkNodes.has(spot.nodeId)
          return (
            // Under the line overlays and building pins (z-index 2 in index.css), even on hover.
            <Marker key={`class-${spot.code}`} longitude={spot.lng} latitude={spot.lat} anchor="center" style={{ zIndex: 1 }}>
              <div
                title={`${spot.name}: ${spot.students.toLocaleString()} in class${dark ? ', building dark' : ''}`}
                className={`rounded-full border-[1.5px] ${dark ? 'border-dashed border-down' : 'border-people'}`}
                style={{
                  width: size,
                  height: size,
                  // A soft fill with an ink edge, so circles read apart from the yellow power and bus lines.
                  background: `color-mix(in srgb, var(--color-people) ${Math.round(14 + share * 34)}%, transparent)`,
                  boxShadow: '0 0 0 1px color-mix(in srgb, var(--color-ink) 55%, transparent)',
                  pointerEvents: armed || placing ? 'none' : undefined,
                }}
              />
            </Marker>
          )
        })}
        {visibleClasses.map((spot) =>
          labeledClasses.has(spot.code) ? (
            // Above the lines; a label that would land on a pin or a name is hidden by declutter.
            <Marker key={`class-label-${spot.code}`} longitude={spot.lng} latitude={spot.lat} anchor="center" style={{ zIndex: 3, pointerEvents: 'none' }}>
              <span
                data-place-label={5}
                className="whitespace-nowrap rounded-sm border border-people/60 bg-ink/90 px-1 py-px font-mono text-[10px] font-semibold tabular-nums text-people data-[off=true]:invisible"
              >
                {spot.code.length <= 6 ? `${spot.code} ` : ''}
                {spot.students >= 1000 ? `${(spot.students / 1000).toFixed(1)}k` : spot.students}
              </span>
            </Marker>
          ) : null,
        )}
        {showSchoolMarkers ? CAMPUSES.map((school) => {
          const compact = zoomLevel > 5.5
          const expandOnHover = compact || (school.collection === 'nearby' && !school.prominent)
          return (
          <Marker
            key={`campus-${school.id}`}
            longitude={school.center[0]}
            latitude={school.center[1]}
            anchor="center"
            style={{ zIndex: school.collection !== 'nearby' || school.prominent ? 20 : 1 }}
          >
            <div className="group relative">
              <button
                type="button"
                title={school.name}
                aria-label={`Open ${school.name} map`}
                onClick={(event) => {
                  event.stopPropagation()
                  openCampus(school.id)
                }}
                className={`relative flex items-center justify-center overflow-hidden border-2 border-white p-1 font-sans text-[9px] font-bold shadow-[0_1px_8px_rgba(0,0,0,0.55)] transition-all duration-150 hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 ${
                  compact
                    ? 'h-2 w-2 rounded-full group-hover:h-10 group-hover:w-10 group-focus-within:h-10 group-focus-within:w-10'
                    : school.collection !== 'nearby' || school.prominent
                      ? 'h-12 w-12 rounded-full'
                      : 'h-3 w-3 rounded-full group-hover:h-10 group-hover:w-10 group-focus-within:h-10 group-focus-within:w-10'
                }`}
                style={{
                  backgroundColor: compact ? school.badgeColor ?? '#334155' : school.logo ? '#fff' : school.badgeColor ?? '#334155',
                  color: compact || !school.logo ? '#fff' : '#1e293b',
                }}
              >
                {school.logo && (
                  <img
                    src={school.logo}
                    alt=""
                    onError={(event) => {
                      event.currentTarget.style.display = 'none'
                      event.currentTarget.nextElementSibling?.classList.remove('hidden')
                    }}
                    className={`absolute inset-1 h-[calc(100%-8px)] w-[calc(100%-8px)] object-contain ${
                      expandOnHover
                        ? 'hidden group-hover:block group-focus-within:block'
                        : ''
                    }`}
                  />
                )}
                <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-5 w-5 ${
                  school.logo
                    ? `hidden ${expandOnHover ? 'group-hover:block group-focus-within:block' : ''}`
                    : expandOnHover
                      ? 'hidden group-hover:block group-focus-within:block'
                      : ''
                }`} fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6M8 10h.01M12 10h.01M16 10h.01" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-max max-w-56 -translate-x-1/2 rounded border border-line bg-panel px-2.5 py-1.5 text-center text-[11px] font-medium text-text opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                {school.name}
              </span>
            </div>
          </Marker>
        )}) : showCampusLandmarks && campus.landmarks.map((landmark) => (
          <Marker key={`${campus.id}-${landmark.name}`} longitude={landmark.point[0]} latitude={landmark.point[1]} anchor="center">
            <CampusDot label={landmark.name} title={`${landmark.name} · ${campus.name}`} />
          </Marker>
        ))}
        {!campusOverview && !isUmich && showCampusPower && (
          <Marker longitude={campus.center[0]} latitude={campus.center[1]} anchor="center">
            <CampusDot
              label={`Illustrative central energy hub · ${campus.name}`}
              title="Illustrative energy hub; not verified campus infrastructure"
              ring="#f59e0b"
              bolt
            />
          </Marker>
        )}
        {!campusOverview && isUmich && nodes.map((node) => {
          const place = PLACES[node.id]
          if (!place || CITY.has(node.id)) return null
          const color = statusColor(node.status)
          const cooling = coolingIds.includes(node.id)
          const flow = cooling && node.status !== 'Red' ? 'go' : node.status === 'Red' && node.type !== 'substation' ? 'leave' : undefined
          const selected = node.id === selectedId
          const named = selected || cooling || node.status !== 'Green'
          const inClass = classByNode[node.id]
          // Energy saver cap, shown only when nothing more urgent is on the pin.
          const cap = !flow && node.limit !== undefined && node.limit < 1 ? `CAP ${Math.round(node.limit * 100)}%` : null
          return (
            <Marker key={node.id} longitude={place.lng} latitude={place.lat} anchor="center">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onNodeClick?.(node)
                }}
                className="group flex flex-col items-center"
                style={armed ? { pointerEvents: 'none' } : undefined}
                title={`${node.name} · ${node.status}${flow === 'go' ? ' · go here' : flow === 'leave' ? ' · leave' : ''}${inClass ? ` · ${inClass.toLocaleString()} in class` : ''}`}
              >
                {flow === 'go' && <span className="mb-0.5 text-xs font-bold tracking-wide text-[#e879f9]">GO · {shelterKind === 'cooling' ? 'COOL' : 'WARM'}</span>}
                {flow === 'leave' && <span className="mb-0.5 text-xs font-bold tracking-wide text-[#fb923c]">LEAVE</span>}
                {cap && (
                  <span className="mb-0.5 whitespace-nowrap rounded-sm bg-ink/85 px-1 font-mono text-[10px] font-semibold tracking-wide text-flow">
                    {cap}
                    {node.capUntil && <span className="hidden group-hover:inline"> · to {node.capUntil}</span>}
                  </span>
                )}
                {/* Pink halo = go here, orange = leave. */}
                <span
                  data-place-dot
                  className="flex rounded-full"
                  style={
                    flow === 'go'
                      ? { boxShadow: '0 0 0 3px #e879f9, 0 0 14px #e879f9' }
                      : flow === 'leave'
                        ? { boxShadow: '0 0 0 3px #fb923c' }
                        : undefined
                  }
                >
                  <CampusDot label={`${place.short} · ${node.status}${flow === 'go' ? ' · go here' : flow === 'leave' ? ' · leave' : ''}`} ring={color} selected={selected} bolt />
                </span>
                {/* Central campus is dense: label only what needs attention, the rest on hover. */}
                <span
                  data-place-name
                  data-place-label={named ? (selected ? 0 : node.status === 'Red' ? 1 : node.status === 'Amber' ? 2 : 3) : undefined}
                  className={`mt-1 ${inClass ? 'max-w-60' : 'max-w-40'} truncate rounded-sm bg-ink/90 px-2 py-1 text-xs font-semibold text-text data-[off=true]:invisible group-hover:data-[off=true]:visible ${
                    named || flow ? '' : 'invisible group-hover:visible'
                  }`}
                >
                  {place.short}
                  {flow === 'go' && (
                    <span className="ml-1 text-[#e879f9]">{shelterKind === 'cooling' ? 'COOL' : 'WARM'}</span>
                  )}
                  {inClass ? <span className="ml-1 text-people">{inClass.toLocaleString()} in class</span> : null}
                </span>
              </button>
            </Marker>
          )
        })}
        {!campusOverview && isUmich && draftPoint && (
          <Marker longitude={draftPoint.lng} latitude={draftPoint.lat} anchor="bottom">
            <div className="flex flex-col items-center">
              <span className="mb-0.5 text-[9px] font-bold tracking-wide text-warn">PIN</span>
              <span className="max-w-36 truncate rounded border border-dashed border-warn bg-ink/85 px-1.5 py-0.5 text-[10px] font-semibold text-warn">
                {draftPoint.name}
              </span>
              <span className="mt-0.5 h-3 w-3 rounded-full border border-ink bg-warn" />
            </div>
          </Marker>
        )}
        {!campusOverview && isUmich && proposals.map((pin) => {
          const color = statusColor(pin.status)
          return (
            <Marker key={pin.id} longitude={pin.lng} latitude={pin.lat} anchor="bottom">
              <div className="flex flex-col items-center" title={`${pin.name} · planned · ${pin.status}`}>
                <span className="mb-0.5 text-[9px] font-bold tracking-wide text-branch">PLANNED</span>
                <span
                  className="max-w-36 truncate rounded bg-ink/85 px-1.5 py-0.5 text-[10px] font-semibold text-text"
                  style={{ border: `1px dashed ${color}` }}
                >
                  {pin.name}
                </span>
                <span className="mt-0.5 h-3 w-3 rounded-full border border-ink" style={{ background: color }} />
              </div>
            </Marker>
          )
        })}
        {!campusOverview && surveyGraph?.nodes.map((building) => {
          const down = surveyDark?.has(building.id) ?? false
          const color = down ? 'var(--color-down)' : 'var(--color-ok)'
          return (
            <Marker key={`survey-${building.id}`} longitude={building.lng} latitude={building.lat} anchor="bottom">
              <button type="button" className="flex flex-col items-center" title={building.why} onClick={() => onToggleSurvey?.(building.id)}>
                <span
                  className="max-w-36 truncate rounded bg-ink/85 px-1.5 py-0.5 text-[10px] font-semibold text-text"
                  style={{ border: `1px solid ${color}` }}
                >
                  {building.name}
                </span>
                <span className="mt-0.5 h-3 w-3 rounded-full border border-ink" style={{ background: color }} />
              </button>
            </Marker>
          )
        })}
      </Map>
      {isUmich && proposals.length > 0 && (
        <LineOverlay
          map={map}
          features={proposals.flatMap((pin) => {
            const place = PLACES[pin.feeder_id]
            if (!place) return []
            return [
              {
                geometry: {
                  coordinates: [
                    [place.lng, place.lat],
                    [pin.lng, pin.lat],
                  ],
                },
                properties: { id: pin.id, color: statusColor(pin.status), dashed: true },
              },
            ]
          })}
          width={2}
        />
      )}
      {!campusOverview && surveyGraph && (
        <LineOverlay
          map={map}
          features={surveyGraph.edges.flatMap((edge) => {
            const from = surveyGraph.nodes.find((node) => node.id === edge.source)
            const to = surveyGraph.nodes.find((node) => node.id === edge.target)
            if (!from || !to) return []
            const down = (surveyDark?.has(from.id) ?? false) || (surveyDark?.has(to.id) ?? false)
            return [
              {
                geometry: {
                  coordinates: [
                    [from.lng, from.lat],
                    [to.lng, to.lat],
                  ],
                },
                properties: {
                  id: edge.id,
                  color: edge.kind === 'power' ? (down ? 'var(--color-down)' : 'var(--color-flow)') : down ? 'var(--color-down)' : 'var(--color-muted)',
                  dashed: edge.kind === 'road' || down,
                },
              },
            ]
          })}
          width={2}
        />
      )}
      {!campusOverview && legend.length > 0 && (!isUmich || !survey) && showBusPanel && (
        <div
          ref={legendRef}
          className={`absolute left-4 z-10 w-60 overflow-y-auto rounded-md border border-line bg-panel/95 p-2 text-xs text-muted [scrollbar-width:thin] ${
            legendRoom ? '' : 'bottom-8'
          }`}
          style={{
            ...(legendRoom ? { top: legendRoom.top, maxHeight: legendRoom.height } : { maxHeight: legendMax ?? 182 }),
            ...(legendMore ? { maskImage: FADE_BOTTOM, WebkitMaskImage: FADE_BOTTOM } : {}),
          }}
          title={legendShort ? 'Fold the scenario dock away to see every line' : undefined}
        >
          <div className={`flex items-baseline justify-between gap-2 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted ${legendShort ? '' : 'mb-1'}`}>
            <span className="flex-1">{isUmich ? 'Bus lines' : 'Illustrative routes'}</span>
            {legendShort && <span className="font-mono font-normal normal-case tracking-normal text-faint">{legend.length} lines</span>}
            <button type="button" aria-label="Hide bus lines panel" onClick={() => setShowBusPanel(false)} className="text-sm leading-none text-muted hover:text-text">×</button>
          </div>
          {!legendShort && legend.map((route) => {
            const out = closedLines[route.id]
            return (
              <div
                key={route.id}
                className={`group/row relative flex w-full items-center gap-1 rounded px-1 py-0.5 ${focus === route.id ? 'bg-raised text-text' : 'hover:text-text'}`}
              >
                <button
                  type="button"
                  onClick={() => setFocus((current) => (current === route.id ? null : route.id))}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <span
                    className="h-1 w-3.5 shrink-0 rounded"
                    style={{
                      background: out === 'suspended' ? 'var(--color-line)' : route.color,
                      outline: route.dashed || out ? '1px dashed #f87171' : undefined,
                    }}
                  />
                  <span className={`min-w-0 truncate ${out === 'suspended' ? 'line-through' : ''}`}>
                    {route.agency} {route.name}
                  </span>
                  {/* The status is the news, so the name gives way, not it. */}
                  {out === 'closed' ? (
                    <span className="-ml-0.5 shrink-0 text-down">· closed</span>
                  ) : out !== 'suspended' && useRouteIds.length > 0 && route.useful ? (
                    <span className="-ml-0.5 shrink-0">· use</span>
                  ) : out !== 'suspended' && route.dashed ? (
                    <span className="-ml-0.5 shrink-0">· reroute</span>
                  ) : null}
                </button>
                {isUmich && <button
                  type="button"
                  onClick={() => storm.toggleRoute(route.id, route.name)}
                  title={out === 'suspended' ? `Put ${route.name} back in service` : `Take ${route.name} out of service`}
                  className={`rounded px-1 font-mono text-[10px] ${
                    out === 'suspended'
                      ? 'shrink-0 text-ok'
                      : // Shown on hover over the row's end, so it takes no room from the name and status.
                        'absolute right-1 top-1/2 -translate-y-1/2 bg-raised text-muted opacity-0 hover:text-down group-hover/row:opacity-100 focus-visible:opacity-100'
                  }`}
                >
                  {out === 'suspended' ? 'restore' : 'suspend'}
                </button>}
              </div>
            )
          })}
        </div>
      )}
      {peopleOn && classClock && (
        // The time of day the circles show. The full controls live in the People tab.
        <div className="absolute left-1/2 top-3.5 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-panel/95 py-1 pl-1 pr-3 text-xs shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
          <button
            type="button"
            onClick={() => onClassSlot?.(classClock.slot - 1)}
            disabled={!onClassSlot || classClock.following || classClock.slot <= 0}
            aria-label="Half an hour earlier"
            className="grid h-6 w-6 place-items-center rounded-full text-muted hover:bg-raised hover:text-text disabled:opacity-30"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => onClassSlot?.(classClock.slot + 1)}
            disabled={!onClassSlot || classClock.following || classClock.slot >= classClock.count - 1}
            aria-label="Half an hour later"
            className="grid h-6 w-6 place-items-center rounded-full text-muted hover:bg-raised hover:text-text disabled:opacity-30"
          >
            ›
          </button>
          <span className={`ml-1 h-2 w-2 shrink-0 rounded-full bg-people ${classClock.following ? 'animate-pulse' : ''}`} />
          <span className="whitespace-nowrap font-semibold">{classClock.label}</span>
          {classClock.following && <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.12em] text-people">clock</span>}
          <span className="whitespace-nowrap font-mono tabular-nums text-muted">{classClock.students.toLocaleString()} in class</span>
          {classClock.following && <span className="whitespace-nowrap text-[10px] uppercase tracking-[0.12em] text-faint">scenario clock</span>}
        </div>
      )}
      {!campusOverview && legend.length > 0 && (!isUmich || !survey) && !showBusPanel && (
        <button
          type="button"
          onClick={() => setShowBusPanel(true)}
          className={`absolute left-4 z-10 rounded-md border border-line bg-panel/95 px-3 py-2 text-xs text-text shadow ${legendRoom ? '' : 'bottom-8'}`}
          style={legendRoom ? { top: legendRoom.top } : undefined}
        >
          Show bus lines
        </button>
      )}
      {/* Weather is a U-M scenario: other campuses and the national view are previews. */}
      {onCampus && (
        <>
          <WeatherCanvas map={map} {...storm.canvas} marks={marks} lightMap={mapTheme === 'day'} hidden={restyling} />
          {/* Box-less wrapper so the dock can be measured without changing how it is placed. */}
          <div ref={dockBox} className="contents">
            <WeatherDock {...storm.dock} />
          </div>
        </>
      )}
      {onCampus && basemap !== 'vector' && (
        <>
          <LineOverlay map={map} features={showRoads ? roads.features : []} color="#94a3b8" width={2} dash="6 6" />
          <LineOverlay map={map} features={showRoads ? shutRoads.features : []} color="#ef4444" width={2} dash="3 4" />
          <LineOverlay map={map} features={showPower ? power.features : []} color="#facc15" width={3} />
          <LineOverlay map={map} features={showPower ? cutPower.features : []} color="#ef4444" width={2.5} dash="3 4" />
          <LineOverlay map={map} features={drawnBuses} width={focus ? 2 : 3} focus={focus} />
        </>
      )}
      {!campusOverview && !isUmich && showBuses && (
        <LineOverlay map={map} features={campusRouteFeatures} width={3} focus={focus} />
      )}
      {!campusOverview && !isUmich && showCampusPower && (
        <LineOverlay map={map} features={campusPowerFeatures} width={2} dash="5 6" />
      )}
      {!campusOverview && showMotion && activeMotionRoutes.length > 0 && (
        <TransitMotion map={map} routes={activeMotionRoutes} />
      )}
      {!campusOverview && !isUmich && (showCampusPower || (showMotion && activeMotionRoutes.length > 0)) && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-[2] -translate-x-1/2 whitespace-nowrap rounded bg-ink/85 px-2 py-1 font-mono text-[10px] text-text">
          ILLUSTRATIVE CAMPUS LAYERS · NOT VERIFIED INFRASTRUCTURE OR LIVE TRANSIT
        </div>
      )}
    </div>
  )
}

interface MotionRoute {
  id: string
  name: string
  color: string
  coordinates: [number, number][]
  /** Part of the whole line this stretch is, so a short open stretch is not crawled along. */
  share?: number
}

function lineMeters(coords: readonly [number, number][]) {
  let total = 0
  for (let i = 1; i < coords.length; i++) total += metersApart(coords[i], { lng: coords[i - 1][0], lat: coords[i - 1][1] })
  return total
}

interface ProjectedRoute {
  route: MotionRoute
  points: { x: number; y: number }[]
  distances: number[]
  total: number
  duration: number
  phaseOffset: number
}

function TransitMotion({ map, routes }: { map: MaplibreMap | null; routes: readonly MotionRoute[] }) {
  const vehicleRefs = useRef(new globalThis.Map<string, SVGGElement>())
  const elapsedRef = useRef(0)
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!map || routes.length === 0) return

    let frame = 0
    let projected: ProjectedRoute[] = []
    let startedAt: number | null = null
    let playing = false
    const vehicles = vehicleRefs.current
    const animationTime = () =>
      elapsedRef.current + (startedAt === null ? 0 : performance.now() - startedAt)
    const projectRoutes = () => {
      const width = map.getCanvas().clientWidth
      const height = map.getCanvas().clientHeight
      projected = routes.flatMap((route) => {
        const phaseOffset = route.id.split('').reduce((hash, character) => hash + character.charCodeAt(0), 0) % 60_000
        const points = route.coordinates.map((coordinate) => map.project(coordinate))
        const distances = [0]
        for (let i = 1; i < points.length; i++) {
          distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y))
        }
        const total = distances[distances.length - 1]
        if (total <= 0) return []
        const visible = points.some((point) => point.x >= -20 && point.x <= width + 20 && point.y >= -20 && point.y <= height + 20)
        if (!visible) return []
        const duration = (150_000 + (phaseOffset % 4) * 18_000) * Math.min(1, Math.max(0.12, route.share ?? 1))
        return [{ route, points, distances, total, duration, phaseOffset }]
      })
    }

    const draw = (time: number) => {
      for (let index = 0; index < projected.length; index++) {
        const path = projected[index]
        const phase = ((time + path.phaseOffset) % (path.duration * 2)) / path.duration
        const fraction = phase <= 1 ? phase : 2 - phase
        const target = fraction * path.total
        let segment = path.distances.findIndex((value) => value >= target)
        if (segment <= 0) segment = 1
        const segmentStart = path.distances[segment - 1]
        const segmentLength = path.distances[segment] - segmentStart
        const progress = segmentLength > 0 ? (target - segmentStart) / segmentLength : 0
        const from = path.points[segment - 1]
        const to = path.points[segment]
        const x = from.x + (to.x - from.x) * progress
        const y = from.y + (to.y - from.y) * progress
        const heading = Math.atan2((phase <= 1 ? to.y : from.y) - y, (phase <= 1 ? to.x : from.x) - x) * (180 / Math.PI)
        const vehicle = vehicles.get(path.route.id)
        if (vehicle) {
          vehicle.style.visibility = 'visible'
          vehicle.setAttribute('transform', `translate(${x} ${y}) rotate(${heading})`)
        }
      }
      const visibleIds = new Set(projected.map((path) => path.route.id))
      for (const [id, vehicle] of vehicles) {
        if (!visibleIds.has(id)) vehicle.style.visibility = 'hidden'
      }
    }

    const pause = () => {
      if (startedAt !== null) {
        elapsedRef.current += performance.now() - startedAt
        startedAt = null
      }
      playing = false
      if (frame) cancelAnimationFrame(frame)
      frame = 0
    }
    const tick = () => {
      draw(reducedMotion ? 12_000 : animationTime())
      if (playing && !reducedMotion) frame = requestAnimationFrame(tick)
    }
    const resume = () => {
      if (playing) return
      projectRoutes()
      if (startedAt === null) startedAt = performance.now()
      playing = true
      draw(reducedMotion ? 12_000 : animationTime())
      if (!reducedMotion) frame = requestAnimationFrame(tick)
    }
    const redrawAfterMapRender = () => {
      projectRoutes()
      draw(reducedMotion ? 12_000 : animationTime())
    }

    resume()
    map.on('movestart', pause)
    map.on('moveend', resume)
    map.on('render', redrawAfterMapRender)
    return () => {
      pause()
      for (const vehicle of vehicles.values()) vehicle.style.visibility = 'hidden'
      elapsedRef.current = animationTime()
      startedAt = null
      map.off('render', redrawAfterMapRender)
      map.off('movestart', pause)
      map.off('moveend', resume)
    }
  }, [map, routes, reducedMotion])

  if (!map || routes.length === 0) return null
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-[2] h-full w-full overflow-hidden">
      {routes.map((route) => (
        <g
          key={route.id}
          ref={(element) => {
            if (element) vehicleRefs.current.set(route.id, element)
            else vehicleRefs.current.delete(route.id)
          }}
          style={{ visibility: 'hidden' }}
          aria-label={`${route.name} illustrative vehicle`}
        >
          <title>{`${route.name} · illustrative movement, not live tracking`}</title>
          <circle r="10" fill="#0b1424" stroke={route.color} strokeWidth="2" />
          <rect x="-6.5" y="-4" width="13" height="8" rx="2" fill={route.color} />
          <path d="M -3 -2.5 h2.5 v2.5 h-2.5 z M 1 -2.5 h2.5 v2.5 h-2.5 z" fill="#0b1424" />
          <circle cx="-3.5" cy="4" r="1" fill="#e6edf7" />
          <circle cx="3.5" cy="4" r="1" fill="#e6edf7" />
        </g>
      ))}
    </svg>
  )
}

function LineOverlay({
  map,
  features,
  color,
  width,
  dash,
  focus,
}: {
  map: MaplibreMap | null
  features: {
    geometry: { coordinates: number[][] }
    properties?: { id?: string; color?: string; dashed?: boolean; useful?: boolean }
  }[]
  color?: string
  width: number
  dash?: string
  focus?: string | null
}) {
  const pathRefs = useRef<(SVGPathElement | null)[]>([])

  useEffect(() => {
    if (!map) return
    const redraw = () => {
      features.forEach((feature, index) => {
        const path = pathRefs.current[index]
        if (!path) return
        const points = feature.geometry.coordinates.map((pair) => {
          const point = map.project([pair[0], pair[1]])
          return `${point.x.toFixed(1)},${point.y.toFixed(1)}`
        })
        path.setAttribute('d', points.length >= 2 ? `M ${points.join(' L ')}` : '')
      })
    }
    redraw()
    map.on('render', redraw)
    return () => {
      map.off('render', redraw)
    }
  }, [map, features, color, width, dash, focus])

  if (!map || features.length === 0) return null
  // Some lines marked "use": the rest fade back.
  const guiding = features.some((item) => item.properties?.useful === false)
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-[1] h-full w-full">
      {features.map((feature, index) => {
        const id = feature.properties?.id
        const useful = feature.properties?.useful !== false
        const selected = (!focus || focus === id) && (useful || focus === id)
        return (
          <path
            key={`${id ?? 'route'}-${index}`}
            ref={(element) => { pathRefs.current[index] = element }}
            fill="none"
            stroke={feature.properties?.color ?? color ?? '#e2e8f0'}
            strokeWidth={focus === id || (guiding && useful && selected) ? width + 2 : width}
            strokeDasharray={feature.properties?.dashed ? '5 5' : dash}
            strokeOpacity={selected ? 1 : 0.15}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )
      })}
    </svg>
  )
}

function metersApart(coord: [number, number], place: { lng: number; lat: number }) {
  const lat = ((coord[1] + place.lat) / 2) * (Math.PI / 180)
  const x = (coord[0] - place.lng) * Math.cos(lat) * 111_320
  const y = (coord[1] - place.lat) * 110_540
  return Math.hypot(x, y)
}

/** Drop the part of a line that serves a dark building, and keep that part as a dashed gap. */
function openAroundDarkStops(
  feature: BusFeature & { properties: BusFeature['properties'] & { color: string; dashed: boolean; skipped: boolean } },
  darkPlaces: Record<string, { lng: number; lat: number }>,
) {
  const stops = feature.properties.near.map((id) => darkPlaces[id]).filter((place) => place)
  if (stops.length === 0) return [feature]
  let open: [number, number][][] = [feature.geometry.coordinates]
  const closed: [number, number][][] = []
  for (const stop of stops) {
    const next: [number, number][][] = []
    for (const line of open) {
      const cut = cutAtStop(line, stop)
      if (!cut) {
        next.push(line)
        continue
      }
      if (cut.gap.length >= 2) closed.push(cut.gap)
      for (const part of cut.keep) {
        if (part.length >= 2) next.push(part)
      }
    }
    open = next
  }
  const running = open.map((coordinates) => lineFeature(feature, coordinates, false))
  const gaps = closed.map((coordinates) => lineFeature(feature, coordinates, true))
  return [...running, ...gaps]
}

function cutAtStop(line: [number, number][], place: { lng: number; lat: number }) {
  let nearest = 0
  let nearestMeters = Infinity
  line.forEach((coord, index) => {
    const distance = metersApart(coord, place)
    if (distance < nearestMeters) {
      nearestMeters = distance
      nearest = index
    }
  })
  if (nearestMeters > 450) return null
  const limit = nearestMeters + 160
  let start = nearest
  let end = nearest
  while (start > 0 && metersApart(line[start - 1], place) <= limit) start -= 1
  while (end < line.length - 1 && metersApart(line[end + 1], place) <= limit) end += 1
  if (end - start < 1) return null
  const keep = [line.slice(0, start + 1), line.slice(end)]
  const gap = line.slice(Math.max(0, start - 1), Math.min(line.length, end + 2))
  return { keep, gap }
}

type DrawnBus = BusFeature & { properties: BusFeature['properties'] & { color: string; dashed: boolean; skipped: boolean } }

/** Lines already split by a set of closures. Every hit re-draws the map, but most lines' closures have not changed. */
const splits = new globalThis.Map<string, { open: LngLat[][]; shut: LngLat[][] }>()

/** Cut the stretches weather closed out of a line. A suspended line is closed end to end. */
function closeForWeather(feature: DrawnBus, closures: readonly ClosedRoute[]): DrawnBus[] {
  const mine = closures.filter((closure) => closure.id === feature.properties.id)
  if (mine.length === 0) return [feature]
  if (mine.some((closure) => closure.segments === null)) return [lineFeature(feature, feature.geometry.coordinates, true)]
  const coords = feature.geometry.coordinates
  const segments = mine.flatMap((closure) => closure.segments ?? [])
  const key = `${feature.properties.id}|${coords.length}|${coords[0]}|${segments.map((sg) => `${sg.length}@${sg[0]}`).join(';')}`
  let split = splits.get(key)
  if (!split) {
    split = splitByClosures(coords, segments)
    if (splits.size > 400) splits.clear()
    splits.set(key, split)
  }
  return [...split.open.map((part) => lineFeature(feature, part, false)), ...split.shut.map((part) => lineFeature(feature, part, true))]
}

function splitLinks(all: ReturnType<typeof links>, out: ReadonlySet<string>) {
  return [
    { ...all, features: all.features.filter((feature) => !out.has(feature.properties.id)) },
    { ...all, features: all.features.filter((feature) => out.has(feature.properties.id)) },
  ] as const
}

function lineFeature(
  feature: BusFeature & { properties: BusFeature['properties'] & { color: string; dashed: boolean; skipped: boolean } },
  coordinates: [number, number][],
  skipped: boolean,
) {
  return {
    ...feature,
    properties: {
      ...feature.properties,
      color: skipped ? '#ef4444' : feature.properties.color,
      dashed: skipped || feature.properties.dashed,
      skipped,
    },
    geometry: { type: 'LineString' as const, coordinates },
  }
}

function distanceBetweenCoordinatesKm(
  [fromLng, fromLat]: readonly [number, number],
  [toLng, toLat]: readonly [number, number],
) {
  const radians = Math.PI / 180
  const latitudeDelta = (toLat - fromLat) * radians
  const longitudeDelta = (toLng - fromLng) * radians
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLat * radians) * Math.cos(toLat * radians) *
      Math.sin(longitudeDelta / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}

function addBuildings(map: MaplibreMap, theme: 'day' | 'night') {
  if (!map.getSource('openmaptiles')) return
  if (map.getLayer('building')) map.setLayoutProperty('building', 'visibility', 'none')
  const buildingColor: string | ExpressionSpecification = theme === 'night'
    ? '#26394d'
    : [
        'interpolate',
        ['linear'],
        ['coalesce', ['get', 'render_height'], 8],
        0,
        '#efe6da',
        12,
        '#d9cfc3',
        30,
        '#b7aa9c',
      ]
  if (map.getLayer('buildings-3d')) {
    map.setPaintProperty('buildings-3d', 'fill-extrusion-color', buildingColor)
    return
  }
  const before = map.getStyle().layers?.find((layer) => layer.type === 'symbol')?.id
  map.addLayer(
    {
      id: 'buildings-3d',
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 13,
      filter: ['!=', ['get', 'hide_3d'], true],
      paint: {
        'fill-extrusion-color': buildingColor,
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 1,
      },
    },
    before,
  )
}

function applyMapTheme(
  map: MaplibreMap,
  theme: 'day' | 'night',
  dayValues: globalThis.Map<string, string | ExpressionSpecification>,
) {
  const night = theme === 'night'
  const setColor = (
    layerId: string,
    property: 'background-color' | 'fill-color' | 'line-color' | 'text-color' | 'text-halo-color',
    nightColor: string,
  ) => {
    const key = `${layerId}:${property}`
    const current = map.getPaintProperty(layerId, property) as string | ExpressionSpecification | undefined
    if (!dayValues.has(key)) {
      if (current === undefined) return
      dayValues.set(key, current)
    }
    const color = night ? nightColor : dayValues.get(key)
    if (!color) return
    switch (property) {
      case 'background-color':
        map.setPaintProperty(layerId, 'background-color', color)
        break
      case 'fill-color':
        map.setPaintProperty(layerId, 'fill-color', color)
        break
      case 'line-color':
        map.setPaintProperty(layerId, 'line-color', color)
        break
      case 'text-color':
        map.setPaintProperty(layerId, 'text-color', color)
        break
      case 'text-halo-color':
        map.setPaintProperty(layerId, 'text-halo-color', color)
        break
    }
  }

  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type === 'background') {
      setColor(layer.id, 'background-color', '#091421')
      continue
    }
    if (layer.type === 'fill') {
      const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : undefined
      const color = sourceLayer === 'water'
        ? '#12385c'
        : sourceLayer === 'park' || sourceLayer === 'landcover'
          ? '#18362f'
          : sourceLayer === 'landuse'
            ? '#1b2735'
            : '#253244'
      setColor(layer.id, 'fill-color', color)
    } else if (layer.type === 'line') {
      const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : undefined
      const casing = layer.id.includes('casing')
      const majorRoad = /motorway|trunk|primary/.test(layer.id)
      const color = sourceLayer === 'waterway'
        ? '#23517b'
        : sourceLayer === 'transportation'
          ? casing ? '#172333' : majorRoad ? '#75859b' : '#47596e'
          : '#536479'
      setColor(layer.id, 'line-color', color)
    } else if (layer.type === 'symbol') {
      setColor(layer.id, 'text-color', '#d7e2ed')
      setColor(layer.id, 'text-halo-color', '#111e2c')
    }
  }

  map.setLight(night
    ? { anchor: 'viewport', color: '#b7c9e2', intensity: 0.28, position: [1.5, 210, 35] }
    : { anchor: 'viewport', color: '#fff3d7', intensity: 0.72, position: [1.15, 210, 45] })
}

function setGroundLines(
  map: MaplibreMap,
  id: string,
  features: Feature<LineString, GeoJsonProperties>[],
  paint: Record<string, unknown>,
) {
  const data: FeatureCollection<LineString, GeoJsonProperties> = { type: 'FeatureCollection', features }
  const before = map.getLayer('buildings-3d') ? 'buildings-3d' : undefined
  const source = map.getSource(id) as { setData?: (next: typeof data) => void } | undefined
  if (source?.setData) {
    source.setData(data)
    return
  }
  map.addSource(id, { type: 'geojson', data })
  map.addLayer(
    {
      id,
      type: 'line',
      source: id,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint,
    },
    before,
  )
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 hover:text-text">
      <input type="checkbox" className="accent-branch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  )
}

/** Class buildings in or near Ann Arbor. A bad geocode elsewhere stays off the map. */
function inTown(lng: number, lat: number) {
  return lng > -83.82 && lng < -83.64 && lat > 42.23 && lat < 42.33
}

function CampusDot({ label, ring = '#38bdf8', selected = false, bolt = false, title }: {
  label: string
  ring?: string
  selected?: boolean
  bolt?: boolean
  title?: string
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={title ?? label}
      tabIndex={bolt ? 0 : undefined}
      className={`flex h-4 w-4 items-center justify-center rounded-full border-2 bg-sky-600 shadow-[0_0_8px_rgba(56,189,248,0.55)] transition-transform duration-150 ${
        selected ? 'scale-125' : ''
      } ${bolt ? 'hover:scale-150 focus-visible:scale-150' : ''}`}
      style={{ borderColor: ring }}
    >
      {bolt && <svg aria-hidden="true" viewBox="0 0 12 16" className="h-2.5 w-2 text-white" fill="currentColor"><path d="M7.1 0 1.8 8h3.5L4.7 16l5.5-9H6.7L7.1 0Z" /></svg>}
    </span>
  )
}

function links(edges: readonly SimEdge[], kind: string) {
  return {
    type: 'FeatureCollection' as const,
    features: edges.flatMap((edge) => {
      if (edge.type !== kind || CITY.has(edge.source) || CITY.has(edge.target)) return []
      const from = PLACES[edge.source]
      const to = PLACES[edge.target]
      if (!from || !to) return []
      return [
        {
          type: 'Feature' as const,
          properties: { id: edge.id },
          geometry: {
            type: 'LineString' as const,
            coordinates: [
              [from.lng, from.lat],
              [to.lng, to.lat],
            ],
          },
        },
      ]
    }),
  }
}

const FADE_BOTTOM = 'linear-gradient(to bottom, #000 calc(100% - 22px), transparent)'

/**
 * Move building names that would overlap to a free side of their dot: below, above,
 * right, then left. Selected and dark buildings choose first. A name with no free
 * side is folded away and shows on hover. Works on the DOM, after MapLibre placed the markers.
 */
function declutter(box: HTMLElement) {
  // Names shown only on hover sit where they were made.
  for (const el of box.querySelectorAll<HTMLElement>('[data-place-name]:not([data-place-label])')) {
    if (!el.dataset.dx && !el.dataset.dy) continue
    el.style.transform = ''
    delete el.dataset.dx
    delete el.dataset.dy
    delete el.dataset.off
  }
  const labels = [...box.querySelectorAll<HTMLElement>('[data-place-label]')]
  const dots = [...box.querySelectorAll<HTMLElement>('[data-place-dot]')]
  const dotBoxes = new globalThis.Map(dots.map((dot) => [dot, dot.getBoundingClientRect()]))
  // Where each name sits with no nudge: its box now, less the nudge it has.
  const items = labels.map((el) => {
    const dx = Number(el.dataset.dx ?? 0)
    const dy = Number(el.dataset.dy ?? 0)
    const r = el.getBoundingClientRect()
    const dot = el.parentElement?.querySelector<HTMLElement>('[data-place-dot]') ?? null
    return { el, rank: Number(el.dataset.placeLabel), x: r.left - dx, y: r.top - dy, w: r.width, h: r.height, dot }
  })
  items.sort((a, b) => a.rank - b.rank)
  const placed: { x: number; y: number; w: number; h: number }[] = []
  const pad = 2
  const free = (x: number, y: number, w: number, h: number, own: HTMLElement | null) => {
    for (const r of placed) if (x < r.x + r.w + pad && x + w + pad > r.x && y < r.y + r.h + pad && y + h + pad > r.y) return false
    for (const [dot, r] of dotBoxes) {
      if (dot === own) continue
      if (x < r.right && x + w > r.left && y < r.bottom && y + h > r.top) return false
    }
    return true
  }
  for (const item of items) {
    const d = item.dot ? dotBoxes.get(item.dot) : undefined
    const spots: [number, number][] = [[item.x, item.y]]
    if (d) {
      const midY = d.top + d.height / 2 - item.h / 2
      spots.push([item.x, d.top - 3 - item.h], [d.right + 4, midY], [d.left - 4 - item.w, midY])
    }
    const spot = spots.find(([x, y]) => free(x, y, item.w, item.h, item.dot))
    const [x, y] = spot ?? [item.x, item.y]
    const dx = Math.round(x - item.x)
    const dy = Math.round(y - item.y)
    item.el.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : ''
    item.el.dataset.dx = String(dx)
    item.el.dataset.dy = String(dy)
    item.el.dataset.off = spot ? 'false' : 'true'
    if (spot) placed.push({ x, y, w: item.w, h: item.h })
  }
}
