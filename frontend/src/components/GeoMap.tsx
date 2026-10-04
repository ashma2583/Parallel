import { useEffect, useMemo, useState } from 'react'
import { Map, Marker, NavigationControl } from '@vis.gl/react-maplibre'
import { setWorkerUrl, type Map as MaplibreMap } from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Briefing, LocationSurvey, ProposalPin } from '../lib/api'
import type { SurveyGraphModel } from '../lib/surveyGraph'
import { BACKEND_URL } from '../config'
import { MAP_STYLE, PLACES, VECTOR_STYLE } from '../lib/places'
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
}

export function GeoMap({
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
}: Props) {
  const [map, setMap] = useState<MaplibreMap | null>(null)
  const [buses, setBuses] = useState<BusCollection>(EMPTY)
  const [showPower, setShowPower] = useState(true)
  const [showRoads, setShowRoads] = useState(false)
  const [showBuses, setShowBuses] = useState(true)
  const [showRecommended, setShowRecommended] = useState(true)
  const [threeD, setThreeD] = useState(false)
  const [basemap, setBasemap] = useState<'raster' | 'vector'>('raster')
  const [focus, setFocus] = useState<string | null>(null)
  const [mapOpacity, setMapOpacity] = useState(1)

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
          ...(useRouteIds.length > 0 ? { useful: useRouteIds.includes(feature.properties.id) } : {}),
        },
      }
    })
  }, [buses, recommended, showBuses, showRecommended, darkPlaces, useRouteIds])

  const drawnBuses = useMemo(
    () => catalog.flatMap((feature) => openAroundDarkStops(feature, darkPlaces)),
    [catalog, darkPlaces],
  )

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

  useEffect(() => {
    if (!map) return
    const apply = () => {
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
    if (!map || basemap !== 'vector') return
    const ground = (features: { geometry: { coordinates: number[][] }; properties?: Record<string, unknown> }[]) =>
      features.map((feature) => ({
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
  }, [map, basemap, showRoads, showPower, roads, power, drawnBuses, focus])

  return (
    <div
      className={`relative h-full ${basemap === 'raster' ? 'map-raster' : 'map-3d'} ${placing ? 'cursor-crosshair' : ''}`}
      style={{ ['--map-opacity' as string]: String(mapOpacity) }}
    >
      <div className="absolute left-4 top-3.5 z-10 flex flex-col gap-1.5 rounded-lg border border-line bg-panel px-3 py-2.5 text-xs shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
        <Toggle label="Power lines" checked={showPower} onChange={setShowPower} />
        <Toggle label="Roads" checked={showRoads} onChange={setShowRoads} />
        <Toggle label="U-M bus lines" checked={showBuses} onChange={setShowBuses} />
        <Toggle label="Recommended routes" checked={showRecommended} onChange={setShowRecommended} />
        <Toggle label="3D view" checked={threeD} onChange={setThreeD} />
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
        <p className="text-[10px] text-muted">pink = go here · orange = leave</p>
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
        {nodes.map((node) => {
          const place = PLACES[node.id]
          if (!place || CITY.has(node.id)) return null
          const color = statusColor(node.status)
          const cooling = coolingIds.includes(node.id)
          const flow = cooling && node.status !== 'Red' ? 'go' : node.status === 'Red' && node.type !== 'substation' ? 'leave' : undefined
          const selected = node.id === selectedId
          return (
            <Marker key={node.id} longitude={place.lng} latitude={place.lat} anchor="center">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onNodeClick?.(node)
                }}
                className="group flex flex-col items-center"
                title={`${node.name} · ${node.status}${flow === 'go' ? ' · go here' : flow === 'leave' ? ' · leave' : ''}`}
              >
                {flow === 'go' && <span className="mb-0.5 text-xs font-bold tracking-wide text-[#e879f9]">GO · {shelterKind === 'cooling' ? 'COOL' : 'WARM'}</span>}
                {flow === 'leave' && <span className="mb-0.5 text-xs font-bold tracking-wide text-[#fb923c]">LEAVE</span>}
                <span
                  className={`rounded-full border-2 border-ink ${selected ? 'ring-1 ring-text' : ''}`}
                  style={{
                    height: flow === 'go' ? 16 : 14,
                    width: flow === 'go' ? 16 : 14,
                    background: color,
                    boxShadow:
                      flow === 'go'
                        ? '0 0 0 4px #e879f9, 0 0 14px #e879f9'
                        : flow === 'leave'
                          ? '0 0 0 3px #fb923c'
                          : `0 0 12px ${color}`,
                  }}
                />
                {/* Central campus is dense: label only what needs attention, the rest on hover. */}
                <span
                  className={`mt-1 max-w-40 truncate rounded-sm bg-ink/90 px-2 py-1 text-xs font-semibold text-text ${
                    selected || cooling || flow || node.status !== 'Green' ? '' : 'invisible group-hover:visible'
                  }`}
                >
                  {place.short}
                  {flow === 'go' && (
                    <span className="ml-1 text-[#e879f9]">{shelterKind === 'cooling' ? 'COOL' : 'WARM'}</span>
                  )}
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
        <div className="absolute bottom-8 left-4 z-10 max-h-52 w-56 overflow-y-auto rounded-md border border-line bg-panel/95 p-2 text-xs text-muted">
          <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Bus lines</div>
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
                {useRouteIds.length > 0 && route.useful ? ' · use' : route.dashed ? ' · reroute' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
      {basemap !== 'vector' && (
        <>
          <LineOverlay map={map} features={showRoads ? roads.features : []} color="#94a3b8" width={2} dash="6 6" />
          <LineOverlay map={map} features={showPower ? power.features : []} color="#facc15" width={3} />
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
    properties?: { id?: string; color?: string; dashed?: boolean; useful?: boolean }
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
          const useful = feature.properties?.useful !== false
          const guiding = features.some((item) => item.properties?.useful === false)
          const selected = (!focus || focus === id) && (useful || focus === id)
          return [
            {
              d: `M ${points.join(' L ')}`,
              color: feature.properties?.color ?? color ?? '#e2e8f0',
              dash: feature.properties?.dashed ? '5 5' : dash,
              opacity: selected ? 1 : 0.15,
              width: focus === id || (guiding && useful && selected) ? width + 2 : width,
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
