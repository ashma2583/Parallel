import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PLACES } from '../lib/places'
import { isSupplier, type SimEdge, type SimNode } from '../lib/sim'
import { TYPE_ICON, fmtPeople, statusColor } from '../lib/status'

interface Props {
  nodes: readonly SimNode[]
  edges: readonly SimEdge[]
  selectedId?: string | null
  onNodeClick?: (node: SimNode) => void
  /** Small, label-free rendering for Branch Timeline columns. */
  mini?: boolean
}

/**
 * The campus as a one-line diagram. Engine layout coordinates are stretched to
 * fill the container, so text and node sizes stay in real pixels at any size.
 */
export function Schematic({ nodes, edges, selectedId, onNodeClick, mini = false }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const placed = useMemo(() => {
    if (!nodes.length || !size.w || !size.h) return new Map<string, { x: number; y: number }>()
    const xs = nodes.map((n) => n.x)
    const ys = nodes.map((n) => n.y)
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const pad = mini ? { l: 14, r: 14, t: 14, b: 14 } : { l: 70, r: 70, t: 44, b: 64 }
    const sx = (size.w - pad.l - pad.r) / Math.max(1, x1 - x0)
    const sy = (size.h - pad.t - pad.b) / Math.max(1, y1 - y0)
    return new Map(nodes.map((n) => [n.id, { x: pad.l + (n.x - x0) * sx, y: pad.t + (n.y - y0) * sy }]))
  }, [nodes, size, mini])

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  return (
    <div ref={box} className="h-full w-full overflow-hidden">
      <svg width={size.w} height={size.h} className="block">
        {edges.map((e) => {
          const a = placed.get(e.source)
          const b = placed.get(e.target)
          const src = byId.get(e.source)
          const dst = byId.get(e.target)
          if (!a || !b || !src || !dst) return null
          if (e.type === 'road') {
            return (
              <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="var(--color-line)" strokeWidth={mini ? 0.75 : 1} strokeDasharray={mini ? '2 3' : '2 5'} />
            )
          }
          const live = !src.failed && !dst.failed && dst.currentPower > 0
          const weak = live && (src.status !== 'Green' || dst.status !== 'Green')
          const color = live ? (weak ? 'var(--color-warn)' : 'var(--color-flow)') : 'var(--color-down)'
          return (
            <g key={e.id}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={color} strokeWidth={mini ? 1 : 1.5} opacity={live ? 0.22 : 0.3}
                strokeDasharray={live ? undefined : '1 5'} />
              {live && !mini && (
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="power-flow"
                  stroke={color} strokeWidth={2} strokeLinecap="round" opacity={0.9} />
              )}
            </g>
          )
        })}

        {nodes.map((n) => {
          const p = placed.get(n.id)
          if (!p) return null
          return (
            <NodeMark key={n.id} node={n} x={p.x} y={p.y} mini={mini}
              selected={n.id === selectedId} onClick={onNodeClick} />
          )
        })}
      </svg>
    </div>
  )
}

interface MarkProps {
  node: SimNode
  x: number
  y: number
  mini: boolean
  selected: boolean
  onClick?: (node: SimNode) => void
}

function NodeMark({ node, x, y, mini, selected, onClick }: MarkProps) {
  const supplier = isSupplier(node)
  const color = statusColor(node.status)
  const nominal = supplier ? node.capacity : node.demand
  // Bigger loads draw bigger, so the eye lands on what matters to the grid.
  const full = supplier ? 24 : 13 + Math.sqrt(nominal) * 0.75
  const r = mini ? full * 0.36 : full
  const ratio = supplier ? (node.failed ? 0 : 1) : Math.max(0, Math.min(1, node.powerRatio))
  const circumference = 2 * Math.PI * r
  const dark = node.status === 'Red'
  const tag = node.failed ? 'OFFLINE' : node.loadShed >= 0.99 ? 'SHED' : node.loadShed > 0.05 ? `SHED ${Math.round(node.loadShed * 100)}%` : null

  return (
    <g transform={`translate(${x},${y})`} onClick={onClick ? () => onClick(node) : undefined}
      style={{ cursor: onClick ? 'pointer' : undefined }}>
      <title>{`${node.name} · ${node.status}`}</title>
      {dark && !mini && <circle r={r} fill="none" stroke={color} strokeWidth={2} className="node-halo" />}
      {selected && <circle r={r + 6} fill="none" stroke="var(--color-text)" strokeWidth={1} strokeDasharray="2 3" />}

      {supplier ? (
        <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={mini ? 2 : 6}
          fill="var(--color-panel)" stroke={color} strokeWidth={mini ? 1.5 : 2.5} />
      ) : (
        <>
          <circle r={r} fill={mini ? color : 'var(--color-panel)'} fillOpacity={mini ? 0.18 + 0.6 * ratio : 1}
            stroke="var(--color-line)" strokeWidth={mini ? 0 : 2.5} />
          <circle r={r} fill="none" stroke={color} strokeWidth={mini ? 1.5 : 2.5} strokeLinecap="round"
            strokeDasharray={mini ? undefined : `${ratio * circumference} ${circumference}`}
            transform="rotate(-90)" style={{ transition: 'stroke-dasharray 0.5s ease, stroke 0.3s' }} />
        </>
      )}

      {!mini && (
        <>
          <path d={TYPE_ICON[node.type] ?? ''} fill={dark ? 'var(--color-faint)' : color}
            transform={`scale(${Math.min(1, r / 19)})`} />
          <text y={r + 15} textAnchor="middle" fontSize={11} fontWeight={500} fill="var(--color-text)"
            stroke="var(--color-ink)" strokeWidth={3} paintOrder="stroke">
            {PLACES[node.id]?.short ?? node.name}
          </text>
          <text y={r + 28} textAnchor="middle" fontSize={10} fontFamily="var(--font-mono)"
            fill={tag ? color : 'var(--color-muted)'} stroke="var(--color-ink)" strokeWidth={3} paintOrder="stroke">
            {tag ?? (supplier
              ? `${Math.round(node.currentPower)} kW out`
              : `${Math.round(node.currentPower)}/${Math.round(node.demand)} · ${fmtPeople(node.occupancy)}`)}
          </text>
        </>
      )}
    </g>
  )
}
