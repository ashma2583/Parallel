import { useMemo } from 'react'
import { Background, BackgroundVariant, Controls, Position, ReactFlow, type Edge, type Node } from '@xyflow/react'
import type { SurveyGraphModel } from '../lib/surveyGraph'

export function SurveyGraph({
  graph,
  dark,
  onToggle,
}: {
  graph: SurveyGraphModel
  dark: ReadonlySet<string>
  onToggle: (id: string) => void
}) {
  const nodes = useMemo<Node[]>(
    () =>
      graph.nodes.map((node) => {
        const down = dark.has(node.id)
        return {
          id: node.id,
          position: { x: node.x, y: node.y },
          data: { label: down ? `${node.name} · offline` : node.name },
          draggable: false,
          connectable: false,
          style: {
            width: 150,
            padding: '8px 10px',
            borderRadius: 12,
            border: `2px solid ${down ? '#ef4444' : '#22c55e'}`,
            background: '#0f172a',
            color: '#e2e8f0',
            fontSize: 12,
          },
          sourcePosition: Position.Bottom,
          targetPosition: Position.Top,
        }
      }),
    [graph.nodes, dark],
  )

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => {
        const down = dark.has(edge.source) || dark.has(edge.target)
        const power = edge.kind === 'power'
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          style: {
            stroke: power ? (down ? '#ef4444' : '#eab308') : down ? '#ef4444' : '#64748b',
            strokeWidth: power ? 2 : 1.5,
            strokeDasharray: power ? undefined : '6 6',
          },
        }
      }),
    [graph.edges, dark],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodeClick={(_event, node) => onToggle(node.id)}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      minZoom={0.3}
      maxZoom={1.6}
      nodesDraggable={false}
      nodesConnectable={false}
    >
      <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#1e293b" />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  )
}
