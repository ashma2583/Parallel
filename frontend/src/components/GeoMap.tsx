import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react'
import { Map, Marker, NavigationControl } from '@vis.gl/react-maplibre'
import { setWorkerUrl, type Map as MaplibreMap } from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Briefing, ClassSpot, LocationSurvey, ProposalPin } from '../lib/api'
import type { ClassClock } from '../lib/classLoad'
import type { SurveyGraphModel } from '../lib/surveyGraph'
import { BACKEND_URL } from '../config'
import { MAP_STYLE, PLACES, VECTOR_STYLE } from '../lib/places'
import type { SimEdge, SimNode } from '../lib/sim'
import { splitByClosures } from '../lib/weather/geo'
import type { BusLine, ClosedRoute, LngLat, WeatherRequest, WeatherState } from '../lib/weather/types'
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

/** Core U-M lines between the campuses. The full list does not change when a building fails. */
const USUAL_RECOMMENDED = new Set(['CN', 'CS', 'BB', 'NW'])

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
}

interface Props {
  ref?: Ref<GeoMapHandle>
  /** The map view is showing. It stays mounted behind the grid view so a run keeps going. */
  active?: boolean
  nodes: readonly SimNode[]
  edges: readonly SimEdge[]
  selectedId?: string | null
  coolingIds?: readonly string[]
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
  /** Students in class by building at the chosen time. Display only. */
  classSpots?: readonly ClassSpot[]
  classClock?: ClassClock | null
  onClassSlot?: (slot: number) => void
}

export function GeoMap({
  ref,
  active = true,
  nodes,
  edges,
  selectedId,
  coolingIds = [],
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
}: Props) {
  const [map, setMap] = useState<MaplibreMap | null>(null)
  const [buses, setBuses] = useState<BusCollection>(EMPTY)
  const [showPower, setShowPower] = useState(true)
  const [showRoads, setShowRoads] = useState(false)
  const [showBuses, setShowBuses] = useState(true)
  const [showRecommended, setShowRecommended] = useState(true)
  const [threeD, setThreeD] = useState(false)
  const [basemap, setBasemap] = useState<'raster' | 'vector'>('raster')
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

  // Class load: circles sized by students in class, on the U-M map only.
  const [showPeople, setShowPeople] = useState(true)
  const peopleOn = showPeople && !survey
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
  // Only the busiest few carry a number, so central campus stays readable.
  const labeledClasses = useMemo(
    () => new Set([...visibleClasses].sort((a, b) => b.students - a.students).slice(0, 6).map((spot) => spot.code)),
    [visibleClasses],
  )

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

  const clearWeather = storm.clear
  useImperativeHandle(ref, () => ({ clearWeather }), [clearWeather])

  const weatherActive = storm.effective.storms.length + closedRoutes.length + cutEdges.length + closedRoads.length > 0
  const running = storm.dock.phase === 'running'
  const hazardKey = storm.hazards.join(',')
  const statusRef = useRef(onWeatherStatus)
  useEffect(() => {
    statusRef.current = onWeatherStatus
  })
  useEffect(() => {
    statusRef.current?.({ active: weatherActive, running, hazards: hazardKey ? hazardKey.split(',') : [] })
  }, [weatherActive, running, hazardKey])

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
  }, [dockOpen])

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
  useEffect(() => {
    if (!map || !dockOpen || survey || map.getZoom() >= 13) return
    map.easeTo({ center: [-83.728, 42.2845], zoom: 13.5, duration: 700 })
  }, [map, dockOpen, survey])

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
        },
      }
    })
  }, [buses, recommended, showBuses, showRecommended, darkPlaces])

  const drawnBuses = useMemo(
    () =>
      catalog
        .flatMap((feature) => closeForWeather(feature, closedRoutes))
        .flatMap((feature) => (feature.properties.skipped ? [feature] : openAroundDarkStops(feature, darkPlaces))),
    [catalog, darkPlaces, closedRoutes],
  )

  const legendShort = legendRoom !== null && legendRoom.height < 72
  const legend = useMemo(
    () =>
      catalog
        .map((feature) => feature.properties)
        .sort((a, b) => a.agency.localeCompare(b.agency) || a.name.localeCompare(b.name)),
    [catalog],
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
  }, [map, nodes, selectedId, coolingIds, active])

  useEffect(() => {
    if (!map) return
    const apply = () => {
      setRestyling(false)
      const vector = Boolean(map.getSource('openmaptiles'))
      setBasemap(vector ? 'vector' : 'raster')
      if (threeD && vector) {
        addBuildings(map)
        map.easeTo({
          pitch: 60,
          bearing: -24,
          zoom: Math.max(map.getZoom(), 15.4),
          center: [-83.7385, 42.2762],
          duration: 800,
        })
      } else if (!threeD && !vector && map.getPitch() > 1) {
        map.easeTo({ pitch: 0, bearing: 0, zoom: 12.4, center: [-83.728, 42.286], duration: 600 })
      }
    }
    if (map.isStyleLoaded()) apply()
    map.on('style.load', apply)
    return () => {
      map.off('style.load', apply)
    }
  }, [map, threeD])

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

  useEffect(() => {
    if (!map || basemap !== 'vector') return
    const ground = (features: { geometry: { coordinates: number[][] }; properties?: Record<string, unknown> }[]) =>
      features.map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          dim: focus && feature.properties?.id !== focus,
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
        'line-width': ['case', ['==', ['get', 'dim'], true], 1.5, 3],
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
  }, [map, basemap, showRoads, showPower, roads, power, cutPower, shutRoads, drawnBuses, focus])

  return (
    <div ref={rootRef} className={`relative h-full ${basemap === 'raster' ? 'map-raster' : 'map-3d'} ${placing ? 'cursor-crosshair' : storm.armed && !map ? 'cursor-progress' : ''}`}>
      <div ref={togglesRef} className="absolute left-4 top-3.5 z-10 flex flex-col gap-1.5 rounded-lg border border-line bg-panel px-3 py-2.5 text-xs shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
        <Toggle label="Power lines" checked={showPower} onChange={setShowPower} />
        <Toggle label="Roads" checked={showRoads} onChange={setShowRoads} />
        <Toggle label="U-M bus lines" checked={showBuses} onChange={setShowBuses} />
        <Toggle label="Recommended routes" checked={showRecommended} onChange={setShowRecommended} />
        <Toggle label="People" checked={showPeople} onChange={setShowPeople} />
        <Toggle label="3D view" checked={threeD} onChange={setThreeD} />
      </div>
      <Map
        mapStyle={threeD ? VECTOR_STYLE : MAP_STYLE}
        initialViewState={{ longitude: -83.728, latitude: 42.286, zoom: 12.4, pitch: 0 }}
        maxPitch={70}
        style={{ width: '100%', height: '100%' }}
        onLoad={onLoad}
        onClick={(event) => {
          if (!placing || !onPlace) return
          onPlace(event.lngLat.lng, event.lngLat.lat)
        }}
        cursor={placing ? 'crosshair' : undefined}
      >
        <NavigationControl position="bottom-right" showCompass />
        {visibleClasses.map((spot) => {
          const share = classMax > 0 ? Math.min(1, spot.students / classMax) : 0
          const size = 14 + Math.sqrt(share) * 52
          return (
            // Under the line overlays and building pins (z-index 2 in index.css), even on hover.
            <Marker key={`class-${spot.code}`} longitude={spot.lng} latitude={spot.lat} anchor="center" style={{ zIndex: 1 }}>
              <div
                title={`${spot.name}: ${spot.students.toLocaleString()} in class`}
                className="flex items-center justify-center rounded-full border border-people"
                style={{
                  width: size,
                  height: size,
                  background: `color-mix(in srgb, var(--color-people) ${Math.round(18 + share * 52)}%, transparent)`,
                  pointerEvents: armed || placing ? 'none' : undefined,
                }}
              >
                {labeledClasses.has(spot.code) && size >= 30 && (
                  <span className="rounded-sm bg-ink/85 px-1 font-mono text-[10px] font-semibold tabular-nums text-people">
                    {spot.students >= 1000 ? `${(spot.students / 1000).toFixed(1)}k` : spot.students}
                  </span>
                )}
              </div>
            </Marker>
          )
        })}
        {nodes.map((node) => {
          const place = PLACES[node.id]
          if (!place || CITY.has(node.id)) return null
          const color = statusColor(node.status)
          const cooling = coolingIds.includes(node.id)
          const selected = node.id === selectedId
          const named = selected || cooling || node.status !== 'Green'
          const inClass = classByNode[node.id]
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
                title={`${node.name} · ${node.status}${inClass ? ` · ${inClass.toLocaleString()} in class` : ''}${cooling ? ' · cooling center' : ''}`}
              >
                <span
                  data-place-dot
                  className={`h-3.5 w-3.5 rounded-full border-2 border-ink ${selected ? 'ring-1 ring-text' : ''}`}
                  style={{ background: color, boxShadow: `0 0 12px ${color}` }}
                />
                {/* Central campus is dense: label only what needs attention, the rest on hover. */}
                <span
                  data-place-name
                  data-place-label={named ? (selected ? 0 : node.status === 'Red' ? 1 : node.status === 'Amber' ? 2 : 3) : undefined}
                  className={`mt-1 ${inClass ? 'max-w-60' : 'max-w-40'} truncate rounded-sm bg-ink/90 px-1.5 py-0.5 text-[10px] font-medium text-text data-[off=true]:invisible group-hover:data-[off=true]:visible ${
                    named ? '' : 'invisible group-hover:visible'
                  }`}
                >
                  {place.short}
                  {cooling && <span className="ml-1 text-transit">cooling</span>}
                  {inClass ? <span className="ml-1 text-people">{inClass.toLocaleString()} in class</span> : null}
                </span>
              </button>
            </Marker>
          )
        })}
        {draftPoint && (
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
        {proposals.map((pin) => {
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
        {surveyGraph?.nodes.map((building) => {
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
      {proposals.length > 0 && (
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
      {surveyGraph && (
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
      {legend.length > 0 && !survey && (
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
          <div className={`flex items-baseline justify-between px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted ${legendShort ? '' : 'mb-1'}`}>
            Bus lines
            {legendShort && <span className="font-mono font-normal normal-case tracking-normal text-faint">{legend.length} lines</span>}
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
                  ) : out !== 'suspended' && route.dashed ? (
                    <span className="-ml-0.5 shrink-0">· reroute</span>
                  ) : null}
                </button>
                <button
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
                </button>
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
            disabled={!onClassSlot || classClock.slot <= 0}
            aria-label="Half an hour earlier"
            className="grid h-6 w-6 place-items-center rounded-full text-muted hover:bg-raised hover:text-text disabled:opacity-30"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => onClassSlot?.(classClock.slot + 1)}
            disabled={!onClassSlot || classClock.slot >= classClock.count - 1}
            aria-label="Half an hour later"
            className="grid h-6 w-6 place-items-center rounded-full text-muted hover:bg-raised hover:text-text disabled:opacity-30"
          >
            ›
          </button>
          <span className="ml-1 h-2 w-2 shrink-0 rounded-full bg-people" />
          <span className="whitespace-nowrap font-semibold">{classClock.label}</span>
          <span className="whitespace-nowrap font-mono tabular-nums text-muted">{classClock.students.toLocaleString()} in class</span>
        </div>
      )}
      <WeatherCanvas map={map} {...storm.canvas} marks={marks} lightMap={basemap === 'vector'} hidden={restyling} />
      {/* Box-less wrapper so the dock can be measured without changing how it is placed. */}
      <div ref={dockBox} className="contents">
        <WeatherDock {...storm.dock} />
      </div>
      {basemap !== 'vector' && (
        <>
          <LineOverlay map={map} features={showRoads ? roads.features : []} color="#94a3b8" width={2} dash="6 6" />
          <LineOverlay map={map} features={showRoads ? shutRoads.features : []} color="#ef4444" width={2} dash="3 4" />
          <LineOverlay map={map} features={showPower ? power.features : []} color="#facc15" width={3} />
          <LineOverlay map={map} features={showPower ? cutPower.features : []} color="#ef4444" width={2.5} dash="3 4" />
          <LineOverlay map={map} features={drawnBuses} width={focus ? 2 : 3} focus={focus} />
        </>
      )}
    </div>
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
    properties?: { id?: string; color?: string; dashed?: boolean }
  }[]
  color?: string
  width: number
  dash?: string
  focus?: string | null
}) {
  const [paths, setPaths] = useState<{ d: string; color: string; dash?: string; opacity: number; width: number }[]>([])

  useEffect(() => {
    if (!map) return
    const redraw = () => {
      setPaths(
        features.flatMap((feature) => {
          const points = feature.geometry.coordinates.map((pair) => {
            const point = map.project([pair[0], pair[1]])
            return `${point.x.toFixed(1)},${point.y.toFixed(1)}`
          })
          if (points.length < 2) return []
          const id = feature.properties?.id
          const selected = !focus || focus === id
          return [
            {
              d: `M ${points.join(' L ')}`,
              color: feature.properties?.color ?? color ?? '#e2e8f0',
              dash: feature.properties?.dashed ? '5 5' : dash,
              opacity: selected ? 1 : 0.15,
              width: selected && focus === id ? width + 2 : width,
            },
          ]
        }),
      )
    }
    redraw()
    map.on('move', redraw)
    map.on('resize', redraw)
    return () => {
      map.off('move', redraw)
      map.off('resize', redraw)
    }
  }, [map, features, color, width, dash, focus])

  if (!map || paths.length === 0) return null
  return (
    <svg className="pointer-events-none absolute inset-0 z-[1] h-full w-full">
      {paths.map((path, index) => (
        <path
          key={index}
          d={path.d}
          fill="none"
          stroke={path.color}
          strokeWidth={path.width}
          strokeDasharray={path.dash}
          strokeOpacity={path.opacity}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
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

function addBuildings(map: MaplibreMap) {
  if (!map.getSource('openmaptiles')) return
  if (map.getLayer('building')) map.setLayoutProperty('building', 'visibility', 'none')
  if (map.getLayer('buildings-3d')) return
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
        'fill-extrusion-color': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'render_height'], 8],
          0,
          '#efe6da',
          12,
          '#d9cfc3',
          30,
          '#b7aa9c',
        ],
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 1,
      },
    },
    before,
  )
}

function setGroundLines(
  map: MaplibreMap,
  id: string,
  features: { geometry: { coordinates: number[][] }; properties?: Record<string, unknown> }[],
  paint: Record<string, unknown>,
) {
  const data = { type: 'FeatureCollection' as const, features }
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
