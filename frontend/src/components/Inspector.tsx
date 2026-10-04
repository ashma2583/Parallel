import { useState } from 'react'
import { disrupt } from '../lib/api'
import { PLACES } from '../lib/places'
import { isSupplier, type SimNode } from '../lib/sim'
import { PRIORITY_LABEL, STATUS_LABEL, TYPE_LABEL, statusColor, type Status } from '../lib/status'

interface Props {
  node: SimNode
  /** The map view keeps its bus-line legend bottom left, so the card moves up. */
  corner?: 'bottom-left' | 'top-right'
  onClose: () => void
  /** Called after the node is failed or restored. `failed` is the new state. */
  onToggled: (node: SimNode, failed: boolean) => void
  /** Students in class here at the People tab's time, for buildings on the class schedule. */
  inClass?: { students: number; when: string } | null
}

/** Card over the map for the selected building. */
export function Inspector({ node, corner = 'bottom-left', onClose, onToggled, inClass = null }: Props) {
  const [busy, setBusy] = useState(false)
  const supplier = isSupplier(node)
  const color = statusColor(node.status)
  const kind = [TYPE_LABEL[node.type] ?? node.type, `${PRIORITY_LABEL[node.priority] ?? node.priority} priority`, PLACES[node.id]?.zone]
    .filter(Boolean)
    .join(' · ')
  const rows: [string, string][] = [
    [supplier ? 'Output' : 'Receiving', `${Math.round(node.currentPower)} kW`],
    [supplier ? 'Capacity' : 'Wants', `${Math.round(supplier ? node.capacity : node.demand)} kW`],
    ['People', node.occupancy.toLocaleString()],
  ]

  const toggle = async () => {
    setBusy(true)
    try {
      await disrupt([node.id], node.failed ? 'restore' : 'fail', 'Manual override')
      onToggled(node, !node.failed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`rise absolute z-10 w-[300px] ${corner === 'top-right' ? 'right-4 top-3.5' : 'bottom-4 left-4'} rounded-lg border border-line bg-panel px-4 py-3.5 shadow-[0_12px_32px_rgba(0,0,0,0.25)]`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold leading-snug">{node.name}</div>
          <div className="mt-0.5 text-xs text-muted">{kind}</div>
        </div>
        <span className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium" style={{ color }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
          {node.failed ? 'Offline' : (STATUS_LABEL[node.status as Status] ?? node.status)}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-[10px] uppercase tracking-[0.12em] text-muted">{label}</dt>
            <dd className="font-mono text-[13px] tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {inClass && (
        <p className="mt-2.5 flex items-center gap-1.5 text-xs text-muted">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-people" />
          {inClass.students > 0 ? (
            <span>
              <span className="font-mono font-semibold tabular-nums text-people">{inClass.students.toLocaleString()}</span> in class now
              {node.status === 'Red' ? ', in the dark' : ''} ({inClass.when})
            </span>
          ) : (
            <span>No classes meeting ({inClass.when})</span>
          )}
        </p>
      )}
      <div className="mt-3.5 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggle()}
          className={`flex-1 rounded-md border px-3 py-1.5 text-[13px] font-medium disabled:opacity-50 ${node.failed ? 'border-ok text-ok' : 'border-down text-down'}`}
        >
          {node.failed ? 'Restore this node' : 'Fail this node'}
        </button>
        <button type="button" onClick={onClose} className="rounded-md border border-line px-3 py-1.5 text-[13px] text-muted">
          Close
        </button>
      </div>
    </div>
  )
}
