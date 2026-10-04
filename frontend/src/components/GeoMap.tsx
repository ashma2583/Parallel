import { useEffect, useMemo, useRef, useState } from 'react'
import { Map, Marker, NavigationControl } from '@vis.gl/react-maplibre'
import { setWorkerUrl, type ExpressionSpecification, type Map as MaplibreMap } from 'maplibre-gl'
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
  const [showCampusPower, setShowCampusPower] = useState(true)
  const [showCampusLandmarks, setShowCampusLandmarks] = useState(true)
  const [threeD, setThreeD] = useState(true)
  const [mapTheme, setMapTheme] = useState<'day' | 'night'>('day')
  const mapThemeRef = useRef<'day' | 'night'>('day')
  const [basemap, setBasemap] = useState<'raster' | 'vector'>('raster')
  const dayPaintValues = useRef(new globalThis.Map<string, string | ExpressionSpecification>())
  const [campusId, setCampusId] = useState<(typeof CAMPUSES)[number]['id']>('umich')
  const keepCameraOnAutomaticCampusChange = useRef(false)
  const [campusOverview, setCampusOverview] = useState(false)
  const [showSchoolMarkers, setShowSchoolMarkers] = useState(false)
  const [zoomLevel, setZoomLevel] = useState(14)
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
      catalog.flatMap((feature) => {
        const coordinates = feature.geometry.coordinates
        if (coordinates.length < 2) return []
        return [{
          id: feature.properties.id,
          name: feature.properties.name,
          color: feature.properties.color,
          coordinates,
        }]
      }),
    [catalog],
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
  const campusPowerFeatures = campus.landmarks.map((landmark, index) => ({
    type: 'Feature' as const,
    properties: { id: `${campus.id}-power-${index}`, color: '#f59e0b', dashed: true },
    geometry: {
      type: 'LineString' as const,
      coordinates: [campus.center, landmark.point],
    },
  }))
  const activeMotionRoutes: MotionRoute[] = isUmich
    ? motionRoutes
    : campus.routes.map((route) => ({ ...route, color: '#38bdf8' }))

  function onLoad(event: { target: MaplibreMap }) {
    setMap(event.target)
  }

  useEffect(() => {
    mapThemeRef.current = mapTheme
  }, [mapTheme])

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
      if (zoom < 8) return

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
        onCampusChange?.()
      }
    }

    updateCampusFromMapCenter()
    map.on('moveend', updateCampusFromMapCenter)
    map.on('zoomend', updateCampusFromMapCenter)
    return () => {
      map.off('moveend', updateCampusFromMapCenter)
      map.off('zoomend', updateCampusFromMapCenter)
    }
  }, [map, campusId, onCampusChange])

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
                  setCampusId(school.id)
                  onCampusChange?.()
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
      {!campusOverview && !isUmich && showCampusPower && (
        <LineOverlay map={map} features={campusPowerFeatures} width={2} dash="5 6" />
      )}
      {!campusOverview && showMotion && activeMotionRoutes.length > 0 && (
        <TransitMotion map={map} routes={activeMotionRoutes} />
      )}
      {!campusOverview && !isUmich && (showCampusPower || (showMotion && activeMotionRoutes.length > 0)) && (
        <div className="pointer-events-none absolute bottom-3 right-4 z-[2] rounded bg-ink/85 px-2 py-1 font-mono text-[10px] text-text">
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
        return [{ route, points, distances, total, duration: 150_000 + (phaseOffset % 4) * 18_000, phaseOffset }]
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
