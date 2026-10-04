import { useState } from 'react'
import type { SimState } from '../module_bindings/types'
import { STATUS_COLOR } from '../lib/status'

interface Props {
  sim: SimState | undefined
  connected: boolean
  connectionError?: Error
  paused: boolean
  onPause: (paused: boolean) => void
  onGoTo: (tick: number) => Promise<string | null>
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className="font-mono text-sm tabular-nums" style={{ color: accent }}>
        {value}
      </span>
    </div>
  )
}

export function StatusBar({ sim, connected, connectionError, paused, onPause, onGoTo }: Props) {
  const deficit = sim?.deficit ?? 0
  const deficitColor = deficit > 0 ? STATUS_COLOR.Red : STATUS_COLOR.Green
  const [target, setTarget] = useState('')
  const [note, setNote] = useState<string | null>(null)

  async function go() {
    const tick = Number(target)
    if (!Number.isFinite(tick) || tick < 1) return
    setNote(await onGoTo(tick))
  }

  return (
    <header className="flex items-center justify-between border-b border-slate-800 bg-slate-950/80 px-5 py-3 backdrop-blur">
      <div className="flex items-center gap-4">
        <div>
          <div className="text-lg font-bold tracking-[0.25em] text-slate-100">PARALLEL</div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Campus Digital Twin · Live</div>
        </div>
        <span
          className="ml-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide"
          style={{
            borderColor: connected ? STATUS_COLOR.Green : STATUS_COLOR.Red,
            color: connected ? STATUS_COLOR.Green : STATUS_COLOR.Red,
          }}
          title={connectionError?.message}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: connected ? STATUS_COLOR.Green : STATUS_COLOR.Red }}
          />
          {connected ? 'SPACETIMEDB LIVE' : 'SPACETIMEDB OFFLINE'}
        </span>
      </div>

      <div className="flex items-center gap-7">
        <div className="flex flex-col gap-1">
          <Stat label="Tick" value={sim ? sim.tick.toString() : '—'} />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onPause(!paused)}
              className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold text-slate-200"
            >
              {paused ? 'Play' : 'Pause'}
            </button>
            <input
              type="number"
              min={1}
              value={target}
              placeholder="tick"
              onChange={(event) => setTarget(event.target.value)}
              className="w-16 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 font-mono text-[10px] text-slate-100"
            />
            <button type="button" onClick={() => void go()} className="rounded bg-sky-400 px-1.5 py-0.5 text-[10px] font-semibold text-slate-950">
              Go
            </button>
          </div>
          {note && <span className="max-w-40 text-[10px] leading-tight text-amber-200">{note}</span>}
        </div>
        <Stat label="Supply" value={sim ? `${Math.round(sim.supply)} kW` : '—'} />
        <Stat label="Demand" value={sim ? `${Math.round(sim.demand)} kW` : '—'} />
        <Stat label="Deficit" value={sim ? `${Math.round(deficit)} kW` : '—'} accent={sim ? deficitColor : undefined} />
        <div className="flex items-center gap-3 border-l border-slate-800 pl-6">
          <Stat label="Green" value={sim ? String(sim.green) : '—'} accent={STATUS_COLOR.Green} />
          <Stat label="Amber" value={sim ? String(sim.amber) : '—'} accent={STATUS_COLOR.Amber} />
          <Stat label="Red" value={sim ? String(sim.red) : '—'} accent={STATUS_COLOR.Red} />
        </div>
      </div>
    </header>
  )
}
