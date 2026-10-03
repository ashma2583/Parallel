import { Map, Marker, NavigationControl } from '@vis.gl/react-maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import { MAP_STYLE, PLACES } from '../lib/places'
import type { SimNode } from '../lib/sim'
import { statusColor } from '../lib/status'

interface Props {
  nodes: readonly SimNode[]
  selectedId?: string | null
  onNodeClick?: (node: SimNode) => void
}

export function GeoMap({ nodes, selectedId, onNodeClick }: Props) {
  return (
    <Map
      mapStyle={MAP_STYLE}
      initialViewState={{ longitude: -83.724, latitude: 42.287, zoom: 12.6 }}
      style={{ width: '100%', height: '100%' }}
    >
      <NavigationControl position="top-right" showCompass={false} />
      {nodes.map((node) => {
        const place = PLACES[node.id]
        if (!place) return null
        const color = statusColor(node.status)
        const selected = node.id === selectedId
        return (
          <Marker key={node.id} longitude={place.lng} latitude={place.lat} anchor="center">
            <button
              type="button"
              onClick={() => onNodeClick?.(node)}
              className="group flex flex-col items-center"
              title={`${node.name} · ${node.status}`}
            >
              <span
                className={`h-3.5 w-3.5 rounded-full border-2 border-ink ${selected ? 'ring-1 ring-text' : ''}`}
                style={{ background: color, boxShadow: `0 0 12px ${color}` }}
              />
              {/* Central campus is dense: label only what needs attention, the rest on hover. */}
              <span
                className={`mt-1 max-w-32 truncate rounded-sm bg-ink/85 px-1.5 py-0.5 text-[10px] font-medium text-text ${
                  selected || node.status !== 'Green' ? '' : 'invisible group-hover:visible'
                }`}
              >
                {place.short}
              </span>
            </button>
          </Marker>
        )
      })}
    </Map>
  )
}
