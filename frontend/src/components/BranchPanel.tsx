import { useEffect, useState } from 'react'
import { adoptStrategy, runBranches, type Branch, type BranchResult } from '../lib/api'
import { STATUS_COLOR, fmtPeople } from '../lib/status'

interface Props {
  /** The branch under the pointer, so the map can show its end state. Null when none. */
  onPreview: (branch: Branch | null) => void
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

const essentialColor = (ratio: number) => (ratio >= 0.999 ? STATUS_COLOR.Green : ratio >= 0.8 ? STATUS_COLOR.Amber : STATUS_COLOR.Red)

/**
 * Right panel while branching. The engine forks the live state and runs every
 * response policy forward on its own copy; each row is one outcome.
 */
export function BranchPanel({ onPreview, onClose, onAdopted }: Props) {
  const [result, setResult] = useState<BranchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [adopting, setAdopting] = useState<string | null>(null)

  useEffect(() => {
    runBranches()
      .then(setResult)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

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
  const winner = result ? best(result.branches) : undefined
  const identical = result ? new Set(result.branches.map((b) => JSON.stringify(b.metrics))).size === 1 : false
  const openId = opened ?? winner

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 pb-3 pt-4">
        <div>
          <div className="text-[15px] font-semibold">Branch timeline</div>
          <p className="mt-1 text-xs leading-normal text-muted">
            {result
              ? `Forked at t${result.baseTick}. Each policy ran ${result.ticks} ticks on its own copy of the campus with the same agents and supply. Comparing leaves the live campus as it is.`
              : 'Forking the live campus and running each response policy…'}
          </p>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 rounded-md border border-line px-2.5 py-[5px] text-xs text-muted transition hover:text-text">
          Back to live <span className="font-mono text-[10px]">Esc</span>
        </button>
      </div>

      {error && <p className="mx-4 mt-3 text-xs text-down">{error}</p>}
      {identical && (
        <p className="mx-4 mt-3 rounded-md border border-line bg-ink px-3 py-2 text-xs text-muted">
          Every policy ends in the same place. Policies only diverge when a feed is short but not dead, so try the heat wave scenario.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" onMouseLeave={() => onPreview(null)}>
        {result?.branches.map((b, index) => {
          const m = b.metrics
          const isLive = b.id === result.active
          const open = b.id === openId
          const color = essentialColor(m.essential_served)
          const delta = live ? points(m.essential_served) - points(live.metrics.essential_served) : 0
          return (
            <div
              key={b.id}
              onMouseEnter={() => {
                setHovered(b.id)
                onPreview(isLive ? null : b)
              }}
              onMouseLeave={() => setHovered(null)}
              onClick={() => setOpened(b.id)}
              className={`rise cursor-pointer border-b border-l-2 border-b-line px-4 py-3.5 ${open ? 'border-l-branch bg-ink' : hovered === b.id ? 'border-l-muted' : 'border-l-transparent'}`}
              style={{ animationDelay: `${index * 60}ms` }}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="whitespace-nowrap text-sm font-semibold">{b.label}</span>
                  {isLive && <span className="rounded-[3px] border border-line px-[5px] py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted">Live</span>}
                  {b.id === winner && !identical && <span className="rounded-[3px] bg-branch px-[5px] py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-onbranch">Best</span>}
                </div>
                <span className="font-mono text-[22px] font-medium leading-none tabular-nums" style={{ color }}>
                  {points(m.essential_served)}
                  <span className="text-xs text-muted">%</span>
                </span>
              </div>
              <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-line">
                <div className="h-full" style={{ width: `${m.essential_served * 100}%`, background: color }} />
              </div>
              <div className="mt-2 flex gap-3.5 whitespace-nowrap font-mono text-[11px] tabular-nums text-muted">
                <span><span className={m.buildings_dark ? 'text-down' : 'text-text'}>{m.buildings_dark}</span> dark</span>
                <span><span className="text-text">{fmtPeople(m.people_relocated)}</span> moved</span>
                <span><span className={m.people_reduced_power ? 'text-warn' : 'text-text'}>{fmtPeople(m.people_reduced_power)}</span> reduced</span>
                {!isLive && Math.abs(delta) >= 0.05 && (
                  <span className={`ml-auto ${delta > 0 ? 'text-ok' : 'text-down'}`}>
                    {delta > 0 ? '+' : '−'}{Math.abs(delta).toFixed(1)} pts
                  </span>
                )}
              </div>

              {open && (
                <>
                  <p className="mt-2.5 text-xs leading-normal text-muted">{b.description}</p>
                  <dl className="mt-2.5">
                    {([
                      ['Critical care served', `${points(m.critical_served)}%`, m.critical_served < 0.999],
                      ['All demand served', `${points(m.total_served)}%`, false],
                      ['People relocated', fmtPeople(m.people_relocated), false],
                    ] as const).map(([label, value, bad]) => (
                      <div key={label} className="flex justify-between gap-3 border-t border-line py-[5px] text-xs">
                        <dt className="text-muted">{label}</dt>
                        <dd className={`font-mono tabular-nums ${bad ? 'text-down' : ''}`}>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <button
                    type="button"
                    disabled={isLive || adopting !== null}
                    onClick={(event) => {
                      event.stopPropagation()
                      void adopt(b.id)
                    }}
                    className={`mt-3 w-full rounded-md border px-3 py-2 text-[13px] font-semibold ${
                      isLive ? 'border-line text-muted' : 'border-branch bg-branch text-onbranch disabled:opacity-50'
                    }`}
                  >
                    {isLive ? 'Running on the live campus' : adopting === b.id ? 'Adopting…' : 'Adopt this timeline'}
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>

      <p className="border-t border-line px-4 py-3 text-[11px] leading-normal text-muted">
        Hover a policy to preview it on the campus. A constraint-based teaching model, not a forecast of the real grid.
      </p>
    </div>
  )
}
