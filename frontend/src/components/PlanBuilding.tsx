import { useState } from 'react'
import type { ProposalImpact, ProposalPin } from '../lib/api'

const KINDS = [
  { id: 'dorm', label: 'Residence hall', people: 1200, kw: 110 },
  { id: 'academic', label: 'Classroom', people: 400, kw: 90 },
  { id: 'research', label: 'Lab', people: 350, kw: 100 },
  { id: 'dining', label: 'Commons', people: 350, kw: 50 },
  { id: 'library', label: 'Library', people: 500, kw: 60 },
] as const

export interface PlanDraft {
  name: string
  kind: string
  people: number
  demand_kw: number
}

export function PlanBuilding({
  placing,
  pinReady,
  confirming,
  impact,
  pins,
  onStart,
  onUndo,
  onConfirm,
  onCancel,
  onRemove,
  error,
}: {
  placing: boolean
  pinReady: boolean
  confirming: boolean
  impact: ProposalImpact | null
  pins: readonly ProposalPin[]
  onStart: (draft: PlanDraft) => void
  onUndo: () => void
  onConfirm: () => void
  onCancel: () => void
  onRemove: (id: string) => void
  error: string | null
}) {
  const [name, setName] = useState('New residence hall')
  const [kind, setKind] = useState<string>('dorm')
  const [people, setPeople] = useState(1200)
  const [kw, setKw] = useState(110)
  const live = pins.find((pin) => pin.id === impact?.id)

  function choose(next: string) {
    const preset = KINDS.find((item) => item.id === next)
    setKind(next)
    if (preset) {
      setPeople(preset.people)
      setKw(preset.kw)
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-[0.14em] text-muted">Plan a U-M building</h2>
      <p className="mb-2 text-sm leading-relaxed text-muted">
        People and kilowatts are your assumption, in the same demo scale as this campus. The feed and the buses come from where you click.
      </p>
      <label className="mb-1 block text-xs text-muted">
        Name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-0.5 w-full rounded border border-line bg-ink px-2 py-1.5 text-sm text-text"
        />
      </label>
      <label className="mb-1 block text-xs text-muted">
        Kind
        <select
          value={kind}
          onChange={(event) => choose(event.target.value)}
          className="mt-0.5 w-full rounded border border-line bg-ink px-2 py-1.5 text-sm text-text"
        >
          {KINDS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <div className="mb-2 flex gap-2">
        <label className="flex-1 text-xs text-muted">
          People
          <input
            type="number"
            min={1}
            max={5000}
            value={people}
            onChange={(event) => setPeople(Number(event.target.value))}
            className="mt-0.5 w-full rounded border border-line bg-ink px-2 py-1.5 text-sm text-text"
          />
        </label>
        <label className="flex-1 text-xs text-muted">
          Demand kW
          <input
            type="number"
            min={1}
            max={400}
            value={kw}
            onChange={(event) => setKw(Number(event.target.value))}
            className="mt-0.5 w-full rounded border border-line bg-ink px-2 py-1.5 text-sm text-text"
          />
        </label>
      </div>
      {placing ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm leading-relaxed text-warn">
            {pinReady ? 'Click the map again to move the pin.' : 'Click the map to drop a pin.'}
          </p>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={!pinReady || confirming}
              onClick={onUndo}
              className="flex-1 rounded border border-line px-2 py-1.5 text-sm font-semibold text-text disabled:text-muted"
            >
              Undo pin
            </button>
            <button
              type="button"
              disabled={!pinReady || confirming}
              onClick={onConfirm}
              className="flex-1 rounded bg-branch px-2 py-1.5 text-sm font-semibold text-onbranch disabled:bg-raised disabled:text-muted"
            >
              {confirming ? 'Adding…' : 'Confirm'}
            </button>
          </div>
          <button type="button" onClick={onCancel} className="text-sm font-semibold text-muted hover:text-text">
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={name.trim().length < 2}
          onClick={() => onStart({ name: name.trim(), kind, people, demand_kw: kw })}
          className="w-full rounded bg-branch px-2 py-1.5 text-sm font-semibold text-onbranch disabled:bg-raised disabled:text-muted"
        >
          Place on the Ann Arbor map
        </button>
      )}
      {error && <p className="mt-2 text-sm leading-relaxed text-down">{error}</p>}
      {impact && (
        <div className="mt-2 rounded-md border border-line bg-ink p-2 text-sm leading-relaxed text-text/80">
          <p className="font-semibold text-text">
            {impact.name}
            {live ? ` · ${live.status}` : ` · ${impact.status}`}
          </p>
          <p className="mt-1">
            Joins the {impact.feeder_label}. That feed was {impact.demand_before_kw} kW and is now {impact.demand_after_kw} kW,
            against {impact.supply_kw} kW of supply
            ({impact.headroom_kw >= 0 ? `${impact.headroom_kw} kW to spare` : `${Math.abs(impact.headroom_kw)} kW short`}).
          </p>
          <p className="mt-1">
            {impact.people.toLocaleString()} people. If it goes dark they walk to {impact.walks_to}. It is drawing{' '}
            {live ? live.received_kw : impact.received_kw} of its {impact.demand_kw} kW.
          </p>
          {impact.shed.length > 0 && <p className="mt-1 text-warn">Shed to make room: {impact.shed.join(', ')}.</p>}
          <p className="mt-1">
            {impact.buses.length > 0
              ? `Buses within a short walk: ${impact.buses.map((bus) => bus.name).join(', ')}.`
              : 'No U-M bus passes within a short walk of this spot.'}
          </p>
        </div>
      )}
      {pins.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {pins.map((pin) => (
            <li key={pin.id} className="flex items-center justify-between gap-2 rounded bg-ink px-2 py-1">
              <span className="truncate text-sm text-text">
                {pin.name}
                <span className="text-muted"> · {pin.status}</span>
              </span>
              <button
                type="button"
                onClick={() => onRemove(pin.id)}
                className="shrink-0 text-sm font-semibold text-muted hover:text-down"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
