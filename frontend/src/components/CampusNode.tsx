import { memo } from 'react'
import { Handle, Position, type Node as FlowNode, type NodeProps } from '@xyflow/react'
import type { Node as NodeRow } from '../module_bindings/types'
import { PRIORITY_LABEL, TYPE_GLYPH, TYPE_LABEL, fmtKw, statusColor } from '../lib/status'

export type CampusFlowNode = FlowNode<{ row: NodeRow; cooling?: boolean }, 'campus'>

/** Invisible centre handles so edges draw centre-to-centre. */
const hiddenHandle: React.CSSProperties = {
  opacity: 0,
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  border: 'none',
  pointerEvents: 'none',
}

function CampusNodeImpl({ data, selected }: NodeProps<CampusFlowNode>) {
  const { row } = data
  const color = statusColor(row.status)
  const isSupplier = row.type === 'substation'
  const nominal = isSupplier ? row.capacity : row.demand
  const ratio = nominal > 0 ? Math.max(0, Math.min(1, row.currentPower / nominal)) : 0
  const compact = row.type === 'transit'

  return (
    <div
      className={[
        'rounded-xl border-2 bg-slate-900/95 text-slate-100 shadow-lg backdrop-blur transition-colors duration-300',
        compact ? 'w-[120px] px-2 py-1.5' : 'w-[168px] px-3 py-2',
        row.status === 'Red' ? 'status-red' : '',
        selected ? 'ring-2 ring-sky-400' : '',
      ].join(' ')}
      style={{ borderColor: color, boxShadow: row.status !== 'Red' ? `0 0 18px ${color}33` : undefined }}
      title={`${row.name}\n${row.status} · ${fmtKw(row.currentPower)} / ${fmtKw(nominal)}`}
    >
      <Handle type="target" position={Position.Top} style={hiddenHandle} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={hiddenHandle} isConnectable={false} />

      {data.cooling && (
        <div className="mb-1 text-[9px] font-bold tracking-wider text-cyan-300">COOLING CENTER</div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-slate-400">
          <span style={{ color }}>{TYPE_GLYPH[row.type] ?? '•'}</span>
          {TYPE_LABEL[row.type] ?? row.type.toUpperCase()}
        </span>
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ background: color, boxShadow: `0 0 8px ${color}` }}
        />
      </div>

      <div className={`truncate font-semibold ${compact ? 'text-[11px]' : 'text-sm'}`}>{row.name}</div>

      {!compact && (
        <>
          <div className="mt-1 flex items-baseline justify-between text-[11px] text-slate-300">
            <span>{isSupplier ? 'Output' : 'Power'}</span>
            <span className="font-mono tabular-nums">
              {Math.round(row.currentPower)}
              <span className="text-slate-500">/{Math.round(nominal)} kW</span>
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-slate-800">
            <div
              className="h-full rounded transition-all duration-500"
              style={{ width: `${ratio * 100}%`, background: color }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-400">
            <span>{isSupplier ? 'Capacity' : `${row.occupancy} ppl`}</span>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-semibold tracking-wide">
              {row.failed
                ? 'OFFLINE'
                : row.loadShed >= 0.99
                  ? 'SHED'
                  : row.loadShed > 0.05
                    ? `SHED ${Math.round(row.loadShed * 100)}%`
                    : (PRIORITY_LABEL[row.priority] ?? row.priority)}
            </span>
          </div>
        </>
      )}
      {compact && (
        <div className="mt-0.5 flex items-center justify-between text-[10px] text-slate-400">
          <span>{row.occupancy} ppl</span>
          <span className="font-mono">{row.failed ? 'OFF' : `${Math.round(row.currentPower)} kW`}</span>
        </div>
      )}
    </div>
  )
}

export const CampusNode = memo(CampusNodeImpl)
