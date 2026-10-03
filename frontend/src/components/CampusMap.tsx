import { useCallback, useMemo } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge as FlowEdge,
  type NodeMouseHandler,
  type NodeTypes,
} from '@xyflow/react'
import type { Edge as EdgeRow, Node as NodeRow } from '../module_bindings/types'
import { CampusNode, type CampusFlowNode } from './CampusNode'
import { statusColor } from '../lib/status'

const nodeTypes: NodeTypes = { campus: CampusNode }

interface Props {
  nodes: readonly NodeRow[]
  edges: readonly EdgeRow[]
  onNodeClick?: (node: NodeRow) => void
}

export function CampusMap({ nodes, edges, onNodeClick }: Props) {
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const flowNodes = useMemo<CampusFlowNode[]>(
    () =>
      nodes.map((row) => ({
        id: row.id,
        type: 'campus',
        position: { x: row.x, y: row.y },
        data: { row },
        draggable: false,
        connectable: false,
      })),
    [nodes],
  )

  const flowEdges = useMemo<FlowEdge[]>(
    () =>
      edges.map((e) => {
        const src = byId.get(e.source)
        const dst = byId.get(e.target)
        if (e.type === 'power') {
          const dead = !src || src.failed || src.status === 'Red'
          const stroke = dead ? '#ef4444' : src.status === 'Amber' ? '#f59e0b' : '#eab308'
          return {
            id: e.id,
            source: e.source,
            target: e.target,
            type: 'straight',
            animated: !dead,
            style: { stroke, strokeWidth: dead ? 1.5 : 2.2, opacity: dead ? 0.45 : 0.85, strokeDasharray: dead ? '4 4' : undefined },
            zIndex: 0,
          }
        }
        // road
        const dim = (src?.status === 'Red' || dst?.status === 'Red')
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'straight',
          style: { stroke: dim ? statusColor('Red') : '#475569', strokeWidth: 1.5, strokeDasharray: '6 6', opacity: dim ? 0.5 : 0.7 },
          zIndex: 0,
        }
      }),
    [edges, byId],
  )

  const handleClick = useCallback<NodeMouseHandler<CampusFlowNode>>(
    (_evt, node) => onNodeClick?.(node.data.row),
    [onNodeClick],
  )

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      onNodeClick={handleClick}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      minZoom={0.4}
      maxZoom={1.8}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
    >
      <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#1e293b" />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  )
}
