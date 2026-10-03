import { useEffect, useMemo, useRef, useState } from 'react'
import { Layer, Map, Marker, NavigationControl, Source } from '@vis.gl/react-maplibre'
import type { Map as MaplibreMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Briefing } from '../lib/api'
import { BACKEND_URL } from '../config'
import { MAP_STYLE, PLACES } from '../lib/places'
import type { SimEdge, SimNode } from '../lib/sim'
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

/** Everyday routes that carry people between the campuses on the map. */
const USUAL_RECOMMENDED = new Set(['CN', 'CS', 'BB', 'NW', '22'])

/**
 * The flat map is dark because the whole canvas is inverted in CSS, so these
 * are the dark counterparts of the colours they show as on screen.
 */
const LINE = {
  road: '#8f95a1',
  power: '#4d3f00',
  bus: '#5e6470',
  broken: '#a30000',
  recommended: '#004a85',
}

interface Props {
  nodes: readonly SimNode[]
  edges: readonly SimEdge[]
  selectedId?: string | null
  coolingIds?: readonly string[]
  reroutes?: Briefing['buses']['reroute']
  onNodeClick?: (node: SimNode) => void
}

export function GeoMap({ nodes, edges, selectedId, coolingIds = [], reroutes = [], onNodeClick }: Props) {
  const mapRef = useRef<MaplibreMap | null>(null)
  const [buses, setBuses] = useState<BusCollection>(EMPTY)
  const [showPower, setShowPower] = useState(true)
  const [showRoads, setShowRoads] = useState(false)
  const [showBuses, setShowBuses] = useState(false)
  const [showRecommended, setShowRecommended] = useState(true)
  const [threeD, setThreeD] = useState(false)

  useEffect(() => {
    let stop = false
    fetch(`${BACKEND_URL}/bus-routes`)
      .then((res) => (res.ok ? res.json() : EMPTY))
      .then((data: BusCollection) => {
        if (!stop) setBuses(data)
      })
      .catch(() => {})
    return () => {
      stop = true
    }
  }, [])

  const power = useMemo(() => links(edges, 'power'), [edges])
  const roads = useMemo(() => links(edges, 'road'), [edges])

  const recommendedIds = useMemo(() => {
    const updated = reroutes.filter((route) => route.keep.length > 0).map((route) => route.id)
    return new Set(updated.length > 0 ? updated : [...USUAL_RECOMMENDED])
  }, [reroutes])

  const recommended = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: buses.features.filter((feature) => recommendedIds.has(feature.properties.id)),
    }),
    [buses, recommendedIds],
  )

  const broken = useMemo(() => {
    const ids = new Set(reroutes.map((route) => route.id))
    return {
      type: 'FeatureCollection' as const,
      features: buses.features.filter((feature) => ids.has(feature.properties.id)),
    }
  }, [buses, reroutes])

  function onLoad(event: { target: MaplibreMap }) {
    mapRef.current = event.target
  }

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!map.isStyleLoaded()) return
    if (threeD) {
      map.easeTo({
        pitch: 60,
        bearing: -20,
        zoom: Math.max(map.getZoom(), 14.4),
        center: [-83.737, 42.278],
        duration: 700,
      })
    } else if (map.getPitch() > 1) {
      map.easeTo({ pitch: 0, bearing: 0, zoom: 12.4, center: [-83.728, 42.286], duration: 600 })
    }
  }, [threeD])

  return (
    <div className={`relative h-full ${threeD ? 'map-3d' : 'map-raster'}`}>
      <div className="absolute left-4 top-14 z-10 flex flex-col gap-1.5 rounded-md border border-line bg-panel/95 px-3 py-2.5 text-xs text-muted">
        <Toggle label="Power lines" checked={showPower} onChange={setShowPower} />
        <Toggle label="Roads" checked={showRoads} onChange={setShowRoads} />
        <Toggle label="Bus routes" checked={showBuses} onChange={setShowBuses} />
        <Toggle label="Recommended routes" checked={showRecommended} onChange={setShowRecommended} />
        <Toggle label="3D view" checked={threeD} onChange={setThreeD} />
      </div>
      <Map
        mapStyle={MAP_STYLE}
        initialViewState={{ longitude: -83.728, latitude: 42.286, zoom: 12.4, pitch: 0 }}
        maxPitch={70}
        style={{ width: '100%', height: '100%' }}
        onLoad={onLoad}
      >
        <NavigationControl position="bottom-right" showCompass />
        {showRoads && (
          <Source id="roads" type="geojson" data={roads}>
            <Layer
              id="roads-line"
              type="line"
              paint={{ 'line-color': LINE.road, 'line-width': 1.5, 'line-dasharray': [1.2, 1.2] }}
            />
          </Source>
        )}
        {showPower && (
          <Source id="power" type="geojson" data={power}>
            <Layer id="power-line" type="line" paint={{ 'line-color': LINE.power, 'line-width': 2, 'line-opacity': 0.8 }} />
          </Source>
        )}
        {showBuses && (
          <Source id="buses" type="geojson" data={buses}>
            <Layer
              id="bus-line"
              type="line"
              paint={{ 'line-color': LINE.bus, 'line-width': 1.4, 'line-opacity': 0.55 }}
            />
          </Source>
        )}
        {showBuses && broken.features.length > 0 && (
          <Source id="buses-broken" type="geojson" data={broken}>
            <Layer
              id="bus-broken"
              type="line"
              paint={{ 'line-color': LINE.broken, 'line-width': 2, 'line-dasharray': [1, 1.4] }}
            />
          </Source>
        )}
        {showRecommended && (
          <Source id="buses-recommended" type="geojson" data={recommended}>
            <Layer id="bus-recommended" type="line" paint={{ 'line-color': LINE.recommended, 'line-width': 3, 'line-opacity': 0.9 }} />
          </Source>
        )}
        {nodes.map((node) => {
          const place = PLACES[node.id]
          if (!place) return null
          const color = statusColor(node.status)
          const cooling = coolingIds.includes(node.id)
          const selected = node.id === selectedId
          return (
            <Marker key={node.id} longitude={place.lng} latitude={place.lat} anchor="center">
              <button
                type="button"
                onClick={() => onNodeClick?.(node)}
                className="group flex flex-col items-center"
                title={`${node.name} · ${node.status}${cooling ? ' · cooling center' : ''}`}
              >
                <span
                  className={`h-3.5 w-3.5 rounded-full border-2 border-ink ${selected ? 'ring-1 ring-text' : ''}`}
                  style={{ background: color, boxShadow: `0 0 12px ${color}` }}
                />
                {/* Central campus is dense: label only what needs attention, the rest on hover. */}
                <span
                  className={`mt-1 max-w-32 truncate rounded-sm bg-ink/85 px-1.5 py-0.5 text-[10px] font-medium text-text ${
                    selected || cooling || node.status !== 'Green' ? '' : 'invisible group-hover:visible'
                  }`}
                >
                  {place.short}
                  {cooling && <span className="ml-1 text-transit">cooling</span>}
                </span>
              </button>
            </Marker>
          )
        })}
      </Map>
    </div>
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
      if (edge.type !== kind) return []
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
