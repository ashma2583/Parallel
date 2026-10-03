import { Map, Marker, NavigationControl } from '@vis.gl/react-maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Node as NodeRow } from '../module_bindings/types'
import { MAP_STYLE, PLACES } from '../lib/places'
import { statusColor } from '../lib/status'

interface Props {
  nodes: readonly NodeRow[]
  onNodeClick?: (node: NodeRow) => void
}

export function GeoMap({ nodes, onNodeClick }: Props) {
  return (
    <Map
      mapStyle={MAP_STYLE}
      initialViewState={{ longitude: -83.728, latitude: 42.286, zoom: 12.4 }}
      style={{ width: '100%', height: '100%' }}
    >
      <NavigationControl position="bottom-right" showCompass={false} />
      {nodes.map((node) => {
        const place = PLACES[node.id]
        if (!place) return null
        const color = statusColor(node.status)
        return (
          <Marker key={node.id} longitude={place.lng} latitude={place.lat} anchor="bottom">
            <button
              type="button"
              onClick={() => onNodeClick?.(node)}
              className="flex flex-col items-center"
              title={`${node.name} · ${node.status}`}
            >
              <span
                className="max-w-36 truncate rounded bg-slate-950/90 px-1.5 py-0.5 text-[10px] font-semibold text-slate-100 shadow"
                style={{ border: `1px solid ${color}` }}
              >
                {node.name}
              </span>
              <span
                className="mt-0.5 h-3 w-3 rounded-full border border-slate-950"
                style={{ background: color, boxShadow: `0 0 10px ${color}` }}
              />
            </button>
          </Marker>
        )
      })}
    </Map>
  )
}
