import { useState } from 'react'
import type { Node as NodeRow } from '../module_bindings/types'
import { disrupt, resetSim, type Briefing, type ClassSpot, type LocationSurvey, type PriorityMode, type ProposalImpact, type ProposalPin } from '../lib/api'
import { STATUS_COLOR, fmtKw } from '../lib/status'
import { BriefingPanel } from './BriefingPanel'
import { LocationPanel } from './LocationPanel'
import { PlanBuilding, type PlanDraft } from './PlanBuilding'
import { ClassLoad } from './ClassLoad'
import { VoicePanel } from './VoicePanel'
import type { SurveyGraphModel } from '../lib/surveyGraph'

interface Scenario {
  label: string
  nodeIds: string[]
  reason: string
}

const SCENARIOS: Scenario[] = [
  { label: 'Fail Central Power Plant', nodeIds: ['cpp'], reason: 'Central campus generation trips offline' },
  { label: 'Fail North Campus Feed', nodeIds: ['north_switch'], reason: 'DTE campus substation feed opens' },
  { label: 'Hospital Switchgear', nodeIds: ['uh'], reason: 'University Hospital intake fails' },
  { label: 'All Campus Feeds', nodeIds: ['cpp', 'uh', 'north_switch'], reason: 'All three campus intakes drop' },
]

interface Props {
  nodes: readonly NodeRow[]
  selected: NodeRow | undefined
  activity: readonly string[]
  briefing: Briefing | null
  onPriority: (mode: PriorityMode) => void
  onSurvey: (survey: LocationSurvey) => void
  onClearSurvey: () => void
  surveyGraph: SurveyGraphModel | null
  surveyDark: ReadonlySet<string>
  onToggleSurvey: (id: string) => void
  placing: boolean
  pinReady: boolean
  confirming: boolean
  proposalImpact: ProposalImpact | null
  proposals: readonly ProposalPin[]
  onStartPlan: (draft: PlanDraft) => void
  onMovePlan: () => void
  onConfirmPlan: () => void
  onCancelPlan: () => void
  onRemoveProposal: (id: string) => void
  planError: string | null
  onClassSpots: (spots: ClassSpot[]) => void
  classSlot: number
  onClassSlot: (slot: number) => void
  onClassClock: (clock: { count: number; label: string; students: number; dayPeak: number } | null) => void
}

export function ControlPanel({
  nodes,
  selected,
  activity,
  briefing,
  onPriority,
  onSurvey,
  onClearSurvey,
  surveyGraph,
  surveyDark,
  onToggleSurvey,
  placing,
  pinReady,
  confirming,
  proposalImpact,
  proposals,
  onStartPlan,
  onMovePlan,
  onConfirmPlan,
  onCancelPlan,
  onRemoveProposal,
  planError,
  onClassSpots,
  classSlot,
  onClassSlot,
  onClassClock,
}: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const failed = nodes.filter((n) => n.failed)

  return (
    <aside className="flex w-80 shrink-0 flex-col gap-5 overflow-y-auto border-l border-slate-800 bg-slate-950/80 p-4 text-sm backdrop-blur">
      <BriefingPanel briefing={briefing} onChoose={onPriority} />

      <ClassLoad onSpots={onClassSpots} slot={classSlot} onSlot={onClassSlot} onClock={onClassClock} />

      <VoicePanel />

      <PlanBuilding
        placing={placing}
        pinReady={pinReady}
        confirming={confirming}
        impact={proposalImpact}
        pins={proposals}
        onStart={onStartPlan}
        onUndo={onMovePlan}
        onConfirm={onConfirmPlan}
        onCancel={onCancelPlan}
        onRemove={onRemoveProposal}
        error={planError}
      />

      <LocationPanel
        onShow={onSurvey}
        onClear={onClearSurvey}
        graph={surveyGraph}
        dark={surveyDark}
        onToggle={onToggleSurvey}
      />

      <section>
        <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Agent feed</h2>
        {activity.length === 0 ? (
          <p className="text-xs text-slate-500">Agents idle. Grid is balanced.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {activity.slice().reverse().map((line, index) => (
              <li key={`${index}-${line}`} className="rounded bg-slate-900 px-2 py-1.5 text-xs text-slate-300">
                {line}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Disruption scenarios</h2>
        <div className="flex flex-col gap-1.5">
          {SCENARIOS.map((s) => (
            <button
              key={s.label}
              disabled={busy}
              onClick={() => run(() => disrupt(s.nodeIds, 'fail', s.reason))}
              className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-left text-slate-200 transition hover:border-red-500/60 hover:bg-red-500/10 disabled:opacity-50"
            >
              {s.label}
            </button>
          ))}
          <button
            disabled={busy}
            onClick={() => run(resetSim)}
            className="mt-1 rounded-md border border-emerald-600/50 bg-emerald-500/10 px-3 py-2 text-left font-semibold text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
          >
            Restore campus
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </section>

      <section>
        <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Selected node</h2>
        {selected ? (
          <div className="rounded-md border border-slate-800 bg-slate-900 p-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold">{selected.name}</span>
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-bold"
                style={{ background: `${STATUS_COLOR[selected.status as keyof typeof STATUS_COLOR] ?? '#64748b'}22`, color: STATUS_COLOR[selected.status as keyof typeof STATUS_COLOR] }}
              >
                {selected.status.toUpperCase()}
              </span>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-300">
              <dt className="text-slate-500">Type</dt>
              <dd className="capitalize">{selected.type}</dd>
              <dt className="text-slate-500">Priority</dt>
              <dd className="capitalize">{selected.priority}</dd>
              <dt className="text-slate-500">Power</dt>
              <dd className="font-mono">{fmtKw(selected.currentPower)}</dd>
              <dt className="text-slate-500">{selected.type === 'substation' ? 'Capacity' : 'Demand'}</dt>
              <dd className="font-mono">{fmtKw(selected.type === 'substation' ? selected.capacity : selected.demand)}</dd>
              <dt className="text-slate-500">Occupancy</dt>
              <dd className="font-mono">{selected.occupancy}</dd>
              <dt className="text-slate-500">Load shed</dt>
              <dd className="font-mono">{Math.round(selected.loadShed * 100)}%</dd>
            </dl>
            <button
              disabled={busy}
              onClick={() =>
                run(() => disrupt([selected.id], selected.failed ? 'restore' : 'fail', 'Manual override'))
              }
              className={`mt-3 w-full rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
                selected.failed
                  ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                  : 'bg-red-500/15 text-red-300 hover:bg-red-500/25'
              }`}
            >
              {selected.failed ? 'Restore node' : 'Fail node'}
            </button>
          </div>
        ) : (
          <p className="text-xs text-slate-500">Click a node on the map to inspect it.</p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Offline nodes ({failed.length})
        </h2>
        {failed.length === 0 ? (
          <p className="text-xs text-slate-500">All nodes online.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {failed.map((n) => (
              <li key={n.id} className="flex items-center justify-between rounded bg-red-500/10 px-2 py-1 text-red-200">
                <span>{n.name}</span>
                <button
                  disabled={busy}
                  onClick={() => run(() => disrupt([n.id], 'restore'))}
                  className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300 hover:underline disabled:opacity-50"
                >
                  restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-auto">
        <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Legend</h2>
        <ul className="flex flex-col gap-1 text-xs text-slate-400">
          {(['Green', 'Amber', 'Red'] as const).map((s) => (
            <li key={s} className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[s] }} />
              {s === 'Green' ? '≥ 90% power' : s === 'Amber' ? '50–90% power' : '< 50% power / offline'}
            </li>
          ))}
          <li className="mt-1 flex items-center gap-2">
            <span className="h-0.5 w-5 bg-yellow-400" /> power line
          </li>
          <li className="flex items-center gap-2">
            <span className="h-0.5 w-5 border-t border-dashed border-slate-500" /> road
          </li>
        </ul>
      </section>
    </aside>
  )
}
