import { useEffect, useMemo, useRef, useState } from 'react'
import { Map, Marker, NavigationControl } from '@vis.gl/react-maplibre'
import { setWorkerUrl, type Map as MaplibreMap } from 'maplibre-gl'
import type { Feature, FeatureCollection, GeoJsonProperties, LineString } from 'geojson'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Briefing, LocationSurvey, ProposalPin } from '../lib/api'
import type { SurveyGraphModel } from '../lib/surveyGraph'
import { BACKEND_URL } from '../config'
import { CAMPUSES, MAP_STYLE, PLACES, VECTOR_STYLE } from '../lib/places'
import type { SimEdge, SimNode } from '../lib/sim'

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

interface Props {
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
  onCampusChange?: () => void
}

export function GeoMap({
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
  onCampusChange,
}: Props) {
  const [map, setMap] = useState<MaplibreMap | null>(null)
  const [buses, setBuses] = useState<BusCollection>(EMPTY)
  const [showPower, setShowPower] = useState(true)
  const [showRoads, setShowRoads] = useState(false)
  const [showBuses, setShowBuses] = useState(true)
  const [showRecommended, setShowRecommended] = useState(true)
  const [showMotion, setShowMotion] = useState(true)
  const [threeD, setThreeD] = useState(true)
  const [basemap, setBasemap] = useState<'raster' | 'vector'>('raster')
  const [campusId, setCampusId] = useState<(typeof CAMPUSES)[number]['id']>('umich')
  const [campusOverview, setCampusOverview] = useState(false)
  const [focus, setFocus] = useState<string | null>(null)
  const [showLayerPanel, setShowLayerPanel] = useState(true)
  const [showBusPanel, setShowBusPanel] = useState(true)
  const campus = CAMPUSES.find((item) => item.id === campusId) ?? CAMPUSES[0]
  const isUmich = campusId === 'umich'

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

  const power = useMemo(() => links(edges, 'power'), [edges])
  const roads = useMemo(() => links(edges, 'road'), [edges])

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
    () => catalog.flatMap((feature) => openAroundDarkStops(feature, darkPlaces)),
    [catalog, darkPlaces],
  )
  const motionRoutes = useMemo(
    () =>
      drawnBuses.flatMap((feature, index) => {
        const coordinates = feature.geometry.coordinates
        if (feature.properties.skipped || coordinates.length < 2) return []
        return [{
          id: `${feature.properties.id}-${index}`,
          name: feature.properties.name,
          color: feature.properties.color,
          coordinates,
        }]
      }),
    [drawnBuses],
  )

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
      }))
  const campusRouteFeatures = campus.routes.map((route) => ({
    type: 'Feature' as const,
    properties: { id: route.id, name: route.name, color: '#38bdf8', dashed: false },
    geometry: { type: 'LineString' as const, coordinates: route.coordinates },
  }))
  const activeMotionRoutes: MotionRoute[] = isUmich
    ? motionRoutes
    : campus.routes.map((route) => ({ ...route, color: '#38bdf8' }))

  function onLoad(event: { target: MaplibreMap }) {
    setMap(event.target)
  }

  useEffect(() => {
    if (!map) return
    const updateOverview = () => {
      const next = map.getZoom() <= 5.5
      setCampusOverview((current) => current === next ? current : next)
    }
    updateOverview()
    map.on('zoom', updateOverview)
    return () => {
      map.off('zoom', updateOverview)
    }
  }, [map])

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
      const vector = Boolean(map.getSource('openmaptiles'))
      setBasemap(vector ? 'vector' : 'raster')
      if (threeD && vector) {
        addBuildings(map)
      }
      map.easeTo({
        pitch: threeD && vector ? 60 : 0,
        bearing: threeD && vector ? -24 : 0,
        zoom: campus.zoom,
        center: campus.center,
        duration: 800,
      })
    }
    if (map.isStyleLoaded()) apply()
    map.on('style.load', apply)
    return () => {
      map.off('style.load', apply)
    }
  }, [map, threeD, campus])

  useEffect(() => {
    if (!map || !survey || survey.buildings.length === 0) return
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
    if (!map || basemap !== 'vector' || !isUmich) return
    const ground = (features: Feature<LineString, GeoJsonProperties>[]) =>
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
  }, [map, basemap, showRoads, showPower, roads, power, drawnBuses, focus, isUmich])

  return (
    <div className={`relative h-full ${basemap === 'raster' ? 'map-raster' : 'map-3d'} ${placing ? 'cursor-crosshair' : ''}`}>
      <label className="absolute right-4 top-3.5 z-10 flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
        Campus
        <select
          aria-label="Select campus"
          value={campusId}
          onChange={(event) => {
            setCampusId(event.target.value as typeof campusId)
            onCampusChange?.()
          }}
          className="max-w-52 bg-panel text-text outline-none"
        >
          <optgroup label="Featured campuses">
            {CAMPUSES.filter((item) => item.collection === 'featured').map((item) => (
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
        <div className="absolute right-4 top-16 z-10 rounded bg-panel/90 px-2.5 py-1.5 font-mono text-[10px] text-muted">
          MAP PREVIEW ONLY · SIMULATION REMAINS U-M
        </div>
      )}
      {showLayerPanel ? (
        <div className="absolute left-4 top-3.5 z-10 flex flex-col gap-1.5 rounded-lg border border-line bg-panel px-3 py-2.5 text-xs shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
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
              <Toggle label="Illustrative bus movement" checked={showMotion} onChange={setShowMotion} />
            </>
          ) : (
            <>
              <Toggle label="Illustrative campus route" checked={showBuses} onChange={setShowBuses} />
              <Toggle label="Illustrative route movement" checked={showMotion} onChange={setShowMotion} />
            </>
          )}
          <Toggle label="3D buildings" checked={threeD} onChange={setThreeD} />
        </div>
      ) : (
        <button type="button" onClick={() => setShowLayerPanel(true)} className="absolute left-4 top-3.5 z-10 rounded-md border border-line bg-panel/95 px-3 py-2 text-xs text-text shadow">
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
        {campusOverview ? CAMPUSES.map((school) => (
          <Marker key={`campus-${school.id}`} longitude={school.center[0]} latitude={school.center[1]} anchor="center">
            <button
              type="button"
              title={school.name}
              aria-label={`Open ${school.name} map`}
              onClick={(event) => {
                event.stopPropagation()
                setCampusId(school.id)
                onCampusChange?.()
              }}
              className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border-2 border-white bg-white p-1 shadow-[0_1px_8px_rgba(0,0,0,0.55)] transition-transform hover:scale-110"
            >
              <img src={school.logo} alt="" className="h-full w-full object-contain" />
            </button>
          </Marker>
        )) : campus.landmarks.map((landmark) => (
          <Marker key={`${campus.id}-${landmark.name}`} longitude={landmark.point[0]} latitude={landmark.point[1]} anchor="center">
            <CampusDot label={landmark.name} title={`${landmark.name} · ${campus.name}`} />
          </Marker>
        ))}
        {!campusOverview && isUmich && nodes.map((node) => {
          const place = PLACES[node.id]
          if (!place || CITY.has(node.id)) return null
          const color = statusColor(node.status)
          const cooling = coolingIds.includes(node.id)
          const selected = node.id === selectedId
          return (
            <Marker key={node.id} longitude={place.lng} latitude={place.lat} anchor="center">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onNodeClick?.(node)
                }}
                className="flex flex-col items-center"
                title={`${node.name} · ${node.status}${cooling ? ' · cooling center' : ''}`}
              >
                <CampusDot label={`${place.short} · ${node.status}${cooling ? ' · cooling center' : ''}`} ring={color} selected={selected} bolt />
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
        {!campusOverview && isUmich && surveyGraph?.nodes.map((building) => {
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
      {isUmich && surveyGraph && (
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
        <div className="absolute bottom-8 left-4 z-10 max-h-52 w-56 overflow-y-auto rounded-md border border-line bg-panel/95 p-2 text-xs text-muted">
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              {isUmich ? 'Bus lines' : 'Illustrative routes'}
            </span>
            <button type="button" aria-label="Hide bus lines panel" onClick={() => setShowBusPanel(false)} className="text-sm leading-none text-muted hover:text-text">×</button>
          </div>
          {legend.map((route) => (
            <button
              key={route.id}
              type="button"
              onClick={() => setFocus((current) => (current === route.id ? null : route.id))}
              className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left ${
                focus === route.id ? 'bg-raised text-text' : 'hover:text-text'
              }`}
            >
              <span
                className="h-1 w-4 shrink-0 rounded"
                style={{ background: route.color, outline: route.dashed ? '1px dashed #f87171' : undefined }}
              />
              <span className="truncate">
                {route.agency} {route.name}
                {route.dashed ? ' · reroute' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
      {!campusOverview && legend.length > 0 && (!isUmich || !survey) && !showBusPanel && (
        <button type="button" onClick={() => setShowBusPanel(true)} className="absolute bottom-8 left-4 z-10 rounded-md border border-line bg-panel/95 px-3 py-2 text-xs text-text shadow">
          Show bus lines
        </button>
      )}
      {!campusOverview && isUmich && basemap !== 'vector' && (
        <>
          <LineOverlay map={map} features={showRoads ? roads.features : []} color="#94a3b8" width={2} dash="6 6" />
          <LineOverlay map={map} features={showPower ? power.features : []} color="#facc15" width={3} />
          <LineOverlay map={map} features={drawnBuses} width={focus ? 2 : 3} focus={focus} />
        </>
      )}
      {!campusOverview && !isUmich && showBuses && (
        <LineOverlay map={map} features={campusRouteFeatures} width={3} focus={focus} />
      )}
      {!campusOverview && showMotion && activeMotionRoutes.length > 0 && (
        <TransitMotion map={map} routes={activeMotionRoutes} />
      )}
      {!campusOverview && !isUmich && showMotion && activeMotionRoutes.length > 0 && (
        <div className="pointer-events-none absolute bottom-3 right-4 z-[2] rounded bg-ink/85 px-2 py-1 font-mono text-[10px] text-text">
          ILLUSTRATIVE ROUTE AND MOVEMENT · NOT LIVE TRANSIT
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
}

interface ProjectedRoute {
  route: MotionRoute
  points: { x: number; y: number }[]
  distances: number[]
  total: number
  duration: number
}

function TransitMotion({ map, routes }: { map: MaplibreMap | null; routes: readonly MotionRoute[] }) {
  const vehicleRefs = useRef(new globalThis.Map<string, SVGGElement>())
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
    const projectRoutes = () => {
      const width = map.getCanvas().clientWidth
      const height = map.getCanvas().clientHeight
      projected = routes.flatMap((route, index) => {
        const points = route.coordinates.map((coordinate) => map.project(coordinate))
        const distances = [0]
        for (let i = 1; i < points.length; i++) {
          distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y))
        }
        const total = distances[distances.length - 1]
        if (total <= 0) return []
        const visible = points.some((point) => point.x >= -20 && point.x <= width + 20 && point.y >= -20 && point.y <= height + 20)
        if (!visible) return []
        return [{ route, points, distances, total, duration: 150_000 + (index % 4) * 18_000 }]
      })
    }

    const draw = (time: number) => {
      for (let index = 0; index < projected.length; index++) {
        const path = projected[index]
        const phase = ((time + index * 5_000) % (path.duration * 2)) / path.duration
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
        const vehicle = vehicleRefs.current.get(path.route.id)
        if (vehicle) {
          vehicle.style.visibility = 'visible'
          vehicle.setAttribute('transform', `translate(${x} ${y}) rotate(${heading})`)
        }
      }
      const visibleIds = new Set(projected.map((path) => path.route.id))
      for (const [id, vehicle] of vehicleRefs.current) {
        if (!visibleIds.has(id)) vehicle.style.visibility = 'hidden'
      }
    }

    const stop = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      for (const vehicle of vehicleRefs.current.values()) vehicle.style.visibility = 'hidden'
    }
    const start = () => {
      projectRoutes()
      draw(reducedMotion ? 12_000 : performance.now())
      if (!reducedMotion) {
        const animate = (time: number) => {
          draw(time)
          frame = requestAnimationFrame(animate)
        }
        frame = requestAnimationFrame(animate)
      }
    }
    const redrawAfterMapRender = () => {
      projectRoutes()
      draw(reducedMotion ? 12_000 : performance.now())
    }

    start()
    map.on('render', redrawAfterMapRender)
    return () => {
      stop()
      map.off('render', redrawAfterMapRender)
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
    properties?: { id?: string; color?: string; dashed?: boolean }
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
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-[1] h-full w-full">
      {features.map((feature, index) => {
        const id = feature.properties?.id
        const selected = !focus || focus === id
        return (
          <path
            key={`${id ?? 'route'}-${index}`}
            ref={(element) => { pathRefs.current[index] = element }}
            fill="none"
            stroke={feature.properties?.color ?? color ?? '#e2e8f0'}
            strokeWidth={selected && focus === id ? width + 2 : width}
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
      className={`flex h-4 w-4 items-center justify-center rounded-full border-2 bg-sky-600 shadow-[0_0_8px_rgba(56,189,248,0.55)] ${
        selected ? 'scale-125' : ''
      }`}
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
