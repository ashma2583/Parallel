import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SurveyGraphModel } from '../lib/surveyGraph'

interface Props {
  graph: SurveyGraphModel
  dark: ReadonlySet<string>
  onToggle: (id: string) => void
}

/** A researched place, drawn in the same one-line style as the campus diagram. */
export function SurveyGraph({ graph, dark, onToggle }: Props) {
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
    if (!graph.nodes.length || !size.w || !size.h) return new Map<string, { x: number; y: number }>()
    const xs = graph.nodes.map((n) => n.x)
    const ys = graph.nodes.map((n) => n.y)
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const pad = { l: 90, r: 90, t: 44, b: 56 }
    const sx = (size.w - pad.l - pad.r) / Math.max(1, x1 - x0)
    const sy = (size.h - pad.t - pad.b) / Math.max(1, y1 - y0)
    return new Map(graph.nodes.map((n) => [n.id, { x: pad.l + (n.x - x0) * sx, y: pad.t + (n.y - y0) * sy }]))
  }, [graph.nodes, size])

  return (
    <div ref={box} className="h-full w-full overflow-hidden">
      <svg width={size.w} height={size.h} className="block">
        {graph.edges.map((edge) => {
          const a = placed.get(edge.source)
          const b = placed.get(edge.target)
          if (!a || !b) return null
          const down = dark.has(edge.source) || dark.has(edge.target)
          if (edge.kind === 'road') {
            return <line key={edge.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--color-line)" strokeWidth={1} strokeDasharray="2 6" />
          }
          return (
            <g key={edge.id}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={down ? 'var(--color-line)' : 'var(--color-flow)'} strokeWidth={1.5}
                opacity={down ? 1 : 0.3} strokeDasharray={down ? '1 5' : undefined} />
              {!down && (
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="power-flow"
                  stroke="var(--color-flow)" strokeWidth={1.8} strokeLinecap="round" opacity={0.9} />
              )}
            </g>
          )
        })}
        {graph.nodes.map((node) => {
          const p = placed.get(node.id)
          if (!p) return null
          const down = dark.has(node.id)
          const color = down ? 'var(--color-down)' : 'var(--color-ok)'
          const plant = node.role === 'power'
          const r = plant ? 18 : 12
          return (
            <g key={node.id} transform={`translate(${p.x},${p.y})`} onClick={() => onToggle(node.id)} style={{ cursor: 'pointer' }}>
              <title>{node.why || node.name}</title>
              {down && <circle r={r} fill="none" stroke="var(--color-down)" strokeWidth={2} className="node-halo" />}
              {plant ? (
                <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={6} fill="var(--color-panel)" stroke={color} strokeWidth={2.5} />
              ) : (
                <circle r={r} fill="var(--color-panel)" stroke={color} strokeWidth={2.5} />
              )}
              <circle r={4} fill={color} fillOpacity={down ? 0.35 : 1} />
              <text y={r + 15} textAnchor="middle" fontSize={11} fontWeight={500} fill="var(--color-text)"
                stroke="var(--color-ink)" strokeWidth={3} paintOrder="stroke">
                {node.name.length > 26 ? `${node.name.slice(0, 25)}…` : node.name}
              </text>
              <text y={r + 28} textAnchor="middle" fontSize={10} fontFamily="var(--font-mono)"
                fill={down ? color : 'var(--color-muted)'} stroke="var(--color-ink)" strokeWidth={3} paintOrder="stroke">
                {down ? 'OFFLINE' : node.role}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
