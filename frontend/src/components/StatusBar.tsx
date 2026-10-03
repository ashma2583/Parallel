import type { SimState } from '../module_bindings/types'
import { STATUS_COLOR } from '../lib/status'

interface Props {
  sim: SimState | undefined
  connected: boolean
  connectionError?: Error
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

export function StatusBar({ sim, connected, connectionError }: Props) {
  const deficit = sim?.deficit ?? 0
  const deficitColor = deficit > 0 ? STATUS_COLOR.Red : STATUS_COLOR.Green

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
        <Stat label="Tick" value={sim ? sim.tick.toString() : '—'} />
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
