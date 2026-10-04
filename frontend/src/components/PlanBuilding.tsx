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
      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Plan a U-M building</h2>
      <p className="mb-2 text-[11px] leading-relaxed text-slate-500">
        People and kilowatts are your assumption, in the same demo scale as this campus. The feed and the buses come from where you click.
      </p>
      <label className="mb-1 block text-[10px] text-slate-500">
        Name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-0.5 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
        />
      </label>
      <label className="mb-1 block text-[10px] text-slate-500">
        Kind
        <select
          value={kind}
          onChange={(event) => choose(event.target.value)}
          className="mt-0.5 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
        >
          {KINDS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <div className="mb-2 flex gap-2">
        <label className="flex-1 text-[10px] text-slate-500">
          People
          <input
            type="number"
            min={1}
            max={5000}
            value={people}
            onChange={(event) => setPeople(Number(event.target.value))}
            className="mt-0.5 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
          />
        </label>
        <label className="flex-1 text-[10px] text-slate-500">
          Demand kW
          <input
            type="number"
            min={1}
            max={400}
            value={kw}
            onChange={(event) => setKw(Number(event.target.value))}
            className="mt-0.5 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
          />
        </label>
      </div>
      {placing ? (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] leading-relaxed text-amber-200">
            {pinReady ? 'Click the map again to move the pin.' : 'Click the map to drop a pin.'}
          </p>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={!pinReady || confirming}
              onClick={onUndo}
              className="flex-1 rounded border border-slate-600 px-2 py-1.5 text-xs font-semibold text-slate-200 disabled:text-slate-600"
            >
              Undo pin
            </button>
            <button
              type="button"
              disabled={!pinReady || confirming}
              onClick={onConfirm}
              className="flex-1 rounded bg-sky-400 px-2 py-1.5 text-xs font-semibold text-slate-950 disabled:bg-slate-800 disabled:text-slate-500"
            >
              {confirming ? 'Adding…' : 'Confirm'}
            </button>
          </div>
          <button type="button" onClick={onCancel} className="text-[10px] font-semibold text-slate-400 hover:text-slate-200">
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={name.trim().length < 2}
          onClick={() => onStart({ name: name.trim(), kind, people, demand_kw: kw })}
          className="w-full rounded bg-sky-400 px-2 py-1.5 text-xs font-semibold text-slate-950 disabled:bg-slate-800 disabled:text-slate-500"
        >
          Place on the Ann Arbor map
        </button>
      )}
      {error && <p className="mt-2 text-[11px] leading-relaxed text-red-300">{error}</p>}
      {impact && (
        <div className="mt-2 rounded-md border border-slate-800 bg-slate-900/80 p-2 text-[11px] leading-relaxed text-slate-300">
          <p className="font-semibold text-slate-100">
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
          {impact.shed.length > 0 && <p className="mt-1 text-amber-200">Shed to make room: {impact.shed.join(', ')}.</p>}
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
            <li key={pin.id} className="flex items-center justify-between gap-2 rounded bg-slate-900 px-2 py-1">
              <span className="truncate text-[11px] text-slate-200">
                {pin.name}
                <span className="text-slate-500"> · {pin.status}</span>
              </span>
              <button
                type="button"
                onClick={() => onRemove(pin.id)}
                className="shrink-0 text-[10px] font-semibold text-slate-400 hover:text-red-300"
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
