import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PLACES } from '../lib/places'
import { allowed, isSupplier, type SimEdge, type SimNode } from '../lib/sim'
import { TYPE_ICON, fmtPeople, statusColor } from '../lib/status'

interface Props {
  nodes: readonly SimNode[]
  edges: readonly SimEdge[]
  selectedId?: string | null
  /** Buildings the briefing says to open as shelters. */
  coolingIds?: readonly string[]
  shelterKind?: 'cooling' | 'warming'
  onNodeClick?: (node: SimNode) => void
}

/** How much text sits under each node. Less as the diagram gets narrower. */
type LabelMode = 'all' | 'names' | 'none'

/**
 * The campus as a one-line diagram. Engine layout coordinates are stretched to
 * fill the container, so text and node sizes stay in real pixels at any size.
 */
export function Schematic({ nodes, edges, selectedId, coolingIds = [], shelterKind = 'warming', onNodeClick }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null)
  const moved = useRef(false)

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
    const pad = { l: 88, r: 88, t: 56, b: 84 }
    const sx = (size.w - pad.l - pad.r) / Math.max(1, x1 - x0)
    const sy = (size.h - pad.t - pad.b) / Math.max(1, y1 - y0)
    return new Map(nodes.map((n) => [n.id, { x: pad.l + (n.x - x0) * sx, y: pad.t + (n.y - y0) * sy }]))
  }, [nodes, size])

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const labels: LabelMode = size.w < 420 ? 'none' : size.w < 640 ? 'names' : 'all'

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = event.clientX - rect.left
      const my = event.clientY - rect.top
      setZoom((current) => {
        const next = Math.min(4, Math.max(0.45, current * (event.deltaY < 0 ? 1.12 : 0.89)))
        setPan((origin) => {
          const wx = (mx - origin.x) / current
          const wy = (my - origin.y) / current
          return { x: mx - wx * next, y: my - wy * next }
        })
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div
      ref={box}
      className="relative h-full w-full overflow-hidden"
      style={{ cursor: drag.current ? 'grabbing' : 'grab', touchAction: 'none' }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        drag.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y, moved: false }
        moved.current = false
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current) return
        const dx = event.clientX - current.x
        const dy = event.clientY - current.y
        if (Math.hypot(dx, dy) > 4) {
          current.moved = true
          moved.current = true
        }
        if (current.moved) setPan({ x: current.px + dx, y: current.py + dy })
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onDoubleClick={() => {
        setZoom(1)
        setPan({ x: 0, y: 0 })
      }}
    >
      <p className="pointer-events-none absolute bottom-3 left-4 text-xs text-muted">Drag to move · scroll to zoom · double-click to reset</p>
      <svg width={size.w} height={size.h} className="block">
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {edges.map((e) => {
          const a = placed.get(e.source)
          const b = placed.get(e.target)
          const src = byId.get(e.source)
          const dst = byId.get(e.target)
          if (!a || !b || !src || !dst) return null
          if (e.type === 'road') {
            return (
              <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="var(--color-line)" strokeWidth={1} strokeDasharray="2 6" />
            )
          }
          const live = !src.failed && !dst.failed && dst.currentPower > 0
          const weak = live && (src.status !== 'Green' || dst.status !== 'Green')
          return (
            <g key={e.id}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={live ? 'var(--color-flow)' : 'var(--color-line)'} strokeWidth={1.5}
                opacity={live ? 0.3 : 1} strokeDasharray={live ? undefined : '1 5'} />
              {live && (
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="power-flow"
                  stroke="var(--color-flow)" strokeWidth={1.8} strokeLinecap="round"
                  opacity={weak ? 0.45 : 0.9} style={{ animationDuration: weak ? '2.6s' : '1.2s' }} />
              )}
            </g>
          )
        })}

        {nodes.map((n) => {
          const p = placed.get(n.id)
          if (!p) return null
          return (
            <NodeMark key={n.id} node={n} x={p.x} y={p.y} labels={labels}
              selected={n.id === selectedId} cooling={coolingIds.includes(n.id)} shelterKind={shelterKind}
              onClick={(node) => {
                if (moved.current) return
                onNodeClick?.(node)
              }} />
          )
        })}
        </g>
      </svg>
    </div>
  )
}

interface MarkProps {
  node: SimNode
  x: number
  y: number
  labels: LabelMode
  selected: boolean
  cooling: boolean
  shelterKind: 'cooling' | 'warming'
  onClick?: (node: SimNode) => void
}

function NodeMark({ node, x, y, labels, selected, cooling, shelterKind, onClick }: MarkProps) {
  const supplier = isSupplier(node)
  const color = statusColor(node.status)
  // Bigger loads draw bigger, so the eye lands on what matters to the grid.
  const r = supplier ? 22 : 12 + Math.sqrt(node.demand) * 0.7
  const ratio = supplier ? (node.failed ? 0 : 1) : Math.max(0, Math.min(1, node.powerRatio))
  const circumference = 2 * Math.PI * r
  const dark = node.status === 'Red'
  const flow = cooling && !dark ? 'go' : dark && node.type !== 'substation' ? 'leave' : null
  const tag = node.failed ? 'OFFLINE' : node.loadShed >= 0.99 ? 'SHED' : node.loadShed > 0.05 ? `SHED ${Math.round(node.loadShed * 100)}%` : null
  const cap = !tag && node.limit !== undefined && node.limit < 1 ? `CAP ${Math.round(node.limit * 100)}%` : null
  const text = { textAnchor: 'middle' as const, stroke: 'var(--color-ink)', strokeWidth: 3, paintOrder: 'stroke' as const }

  return (
    <g transform={`translate(${x},${y})`} onClick={onClick ? () => onClick(node) : undefined}
      style={{ cursor: onClick ? 'pointer' : undefined }}>
      <title>{`${node.name} · ${node.status}${cap ? ` · ${cap}${node.capUntil ? ` to ${node.capUntil}` : ''}` : ''}`}</title>
      {dark && flow !== 'leave' && <circle r={r} fill="none" stroke="var(--color-down)" strokeWidth={2} className="node-halo" />}
      {flow === 'go' && <circle r={r + 7} fill="none" stroke="#e879f9" strokeWidth={3} />}
      {flow === 'leave' && <circle r={r + 6} fill="none" stroke="#fb923c" strokeWidth={2.5} />}
      {selected && <circle r={r + 10} fill="none" stroke="var(--color-text)" strokeWidth={1} strokeDasharray="2 3" />}

      {supplier ? (
        <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={6}
          fill="var(--color-panel)" stroke={color} strokeWidth={2.5} />
      ) : (
        <>
          <circle r={r} fill="var(--color-panel)" stroke="var(--color-line)" strokeWidth={2.5} />
          <circle r={r} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round"
            strokeDasharray={`${ratio * circumference} ${circumference}`}
            transform="rotate(-90)" style={{ transition: 'stroke-dasharray 0.5s ease, stroke 0.3s' }} />
        </>
      )}
      <path d={TYPE_ICON[node.type] ?? ''} fill={dark ? 'var(--color-muted)' : color}
        transform={`scale(${Math.min(1, r / 19)})`} />

      {labels !== 'none' && (
        <text {...text} y={r + 20} fontSize={15} fontWeight={650} fill="var(--color-text)">
          {PLACES[node.id]?.short ?? node.name}
        </text>
      )}
      {labels === 'all' && (
        <text {...text} y={r + 38} fontSize={13} fontFamily="var(--font-mono)" fill={tag ? color : cap ? 'var(--color-flow)' : 'var(--color-text)'}>
          {/* A capped building reads against its cap, so it does not look short. */}
          {tag ?? (cap ? `${cap} · ${Math.round(node.currentPower)}/${Math.round(allowed(node))} kW` : null) ?? (supplier
            ? `${Math.round(node.currentPower)} kW out`
            : `${Math.round(node.currentPower)}/${Math.round(node.demand)} kW · ${fmtPeople(node.occupancy)}`)}
        </text>
      )}
      {flow && (
        <text {...text} y={-r - 14} fontSize={14} fontWeight={800} letterSpacing="0.06em" fill={flow === 'go' ? '#e879f9' : '#fb923c'}>
          {flow === 'go' ? (shelterKind === 'cooling' ? 'GO · COOL' : 'GO · WARM') : 'LEAVE'}
        </text>
      )}
    </g>
  )
}
