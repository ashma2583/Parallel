import { useEffect, useState } from 'react'
import { adoptStrategy, runBranches, type Branch, type BranchResult } from '../lib/api'
import type { SimEdge } from '../lib/sim'
import { STATUS_COLOR, fmtPeople } from '../lib/status'
import { Schematic } from './Schematic'

interface Props {
  edges: readonly SimEdge[]
  onClose: () => void
  onAdopted: () => void
}

const points = (ratio: number) => Math.round(ratio * 1000) / 10

/** Highest essential service wins; fewer people moved breaks a tie. */
function best(branches: Branch[]): string | undefined {
  return [...branches].sort(
    (a, b) =>
      b.metrics.essential_served - a.metrics.essential_served ||
      a.metrics.people_relocated - b.metrics.people_relocated,
  )[0]?.id
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-line py-1.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-mono text-[13px] tabular-nums" style={{ color }}>{value}</dd>
    </div>
  )
}

/**
 * Branch Timeline. The engine forks the live state and runs every response
 * policy forward on its own copy; this lays the outcomes side by side.
 */
export function BranchView({ edges, onClose, onAdopted }: Props) {
  const [result, setResult] = useState<BranchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adopting, setAdopting] = useState<string | null>(null)

  useEffect(() => {
    runBranches()
      .then(setResult)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const adopt = async (id: string) => {
    setAdopting(id)
    try {
      await adoptStrategy(id)
      onAdopted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setAdopting(null)
    }
  }

  const live = result?.branches.find((b) => b.id === result.active)
  const winner = result && best(result.branches)
  const identical = result ? new Set(result.branches.map((b) => JSON.stringify(b.metrics))).size === 1 : false

  return (
    <div className="absolute inset-0 z-20 flex flex-col overflow-y-auto bg-ink px-6 py-5">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-xl font-semibold">Branch timeline</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-muted">
            {result
              ? `Forked at tick ${result.baseTick}. Each policy ran ${result.ticks} ticks on its own copy of the campus, with the same agents and the same supply. The live campus has not changed.`
              : 'Forking the live campus and running each response policy…'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md border border-line px-3 py-1.5 text-[13px] text-muted transition hover:text-text"
        >
          Back to live <span className="ml-1 font-mono text-[11px] text-faint">Esc</span>
        </button>
      </div>

      {error && <p className="mt-4 text-sm text-down">{error}</p>}
      {identical && (
        <p className="mt-4 rounded-md border border-line bg-panel px-3 py-2 text-[13px] text-muted">
          Every policy ends in the same place. Policies only diverge when a feed is short but not dead, so try the heat wave scenario.
        </p>
      )}

      {result && (
        <div className="mt-5 grid flex-1 grid-cols-2 gap-4 xl:grid-cols-5">
          {result.branches.map((b, index) => {
            const m = b.metrics
            const isLive = b.id === result.active
            const delta = live ? points(m.essential_served) - points(live.metrics.essential_served) : 0
            const essentialColor = m.essential_served >= 0.999 ? STATUS_COLOR.Green : m.essential_served >= 0.8 ? STATUS_COLOR.Amber : STATUS_COLOR.Red
            return (
              <article
                key={b.id}
                className={`rise flex flex-col rounded-lg border bg-panel p-4 ${b.id === winner && !identical ? 'border-branch' : 'border-line'}`}
                style={{ animationDelay: `${index * 70}ms` }}
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-[15px] font-semibold">{b.label}</h2>
                  <span className="flex gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em]">
                    {isLive && <span className="rounded-sm bg-raised px-1.5 py-0.5 text-muted">Live now</span>}
                    {b.id === winner && !identical && <span className="rounded-sm bg-branch px-1.5 py-0.5 text-ink">Best</span>}
                  </span>
                </div>
                <p className="mt-1 min-h-10 text-xs text-muted">{b.description}</p>

                <div className="mt-3 flex items-end gap-2.5">
                  <span className="font-mono text-5xl font-medium leading-none tabular-nums" style={{ color: essentialColor }}>
                    {points(m.essential_served)}
                    <span className="text-2xl">%</span>
                  </span>
                  {!isLive && Math.abs(delta) >= 0.05 && (
                    <span className="pb-0.5 font-mono text-xs tabular-nums" style={{ color: delta > 0 ? STATUS_COLOR.Green : STATUS_COLOR.Red }}>
                      {delta > 0 ? '+' : '−'}{Math.abs(delta).toFixed(1)} pts vs live
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-faint">Essential demand served</div>

                <div className="mt-4 min-h-40 flex-1 rounded-md bg-ink">
                  <Schematic nodes={b.nodes} edges={edges} mini />
                </div>

                <dl className="mt-3">
                  <Row label="Critical care served" value={`${points(m.critical_served)}%`}
                    color={m.critical_served < 0.999 ? STATUS_COLOR.Red : undefined} />
                  <Row label="All demand served" value={`${points(m.total_served)}%`} />
                  <Row label="People relocated" value={fmtPeople(m.people_relocated)} />
                  <Row label="People on reduced power" value={fmtPeople(m.people_reduced_power)}
                    color={m.people_reduced_power > 0 ? STATUS_COLOR.Amber : undefined} />
                  <Row label="Buildings dark" value={String(m.buildings_dark)}
                    color={m.buildings_dark > 0 ? STATUS_COLOR.Red : undefined} />
                </dl>

                <button
                  type="button"
                  disabled={isLive || adopting !== null}
                  onClick={() => void adopt(b.id)}
                  className={`mt-3 rounded-md px-3 py-2 text-[13px] font-semibold transition ${
                    isLive
                      ? 'border border-line text-faint'
                      : 'bg-branch text-ink hover:brightness-110 disabled:opacity-50'
                  }`}
                >
                  {isLive ? 'Running on the live campus' : adopting === b.id ? 'Adopting…' : 'Adopt this timeline'}
                </button>
              </article>
            )
          })}
        </div>
      )}

      <p className="mt-4 text-xs text-faint">
        A constraint-based teaching model. These numbers come from running the simulation, and are not a forecast of the real campus grid.
      </p>
    </div>
  )
}
