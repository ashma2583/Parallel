import { useEffect, useMemo, useState } from 'react'
import {
  SAVER_POLICIES,
  WEEKDAYS,
  applySaver,
  clearSaver,
  compareSaver,
  fetchSaverCampuses,
  fetchSaverPlan,
  hhmm,
  type SaverBuilding,
  type SaverCampus,
  type SaverCompare,
  type SaverLive,
  type SaverPlan,
  type SaverPolicy,
} from '../lib/saver'
import { PLACES } from '../lib/places'
import { fmtPeople } from '../lib/status'

interface Props {
  live: SaverLive | null
  onClose: () => void
  onChanged: () => void
}

// Rows shown in the heatmap, in this order. Feeds and city buildings are left out.
const TYPE_ORDER = ['academic', 'library', 'dining', 'research', 'dorm', 'hospital']
const TYPE_LABEL: Record<string, string> = {
  academic: 'Academic', library: 'Library', dining: 'Dining', research: 'Lab', dorm: 'Dorm', hospital: 'Hospital',
}

// Four steps of one hue: the deeper the cut, the more ink. Uncapped is the plain surface.
const STEPS = [
  { max: 0.85, mix: 30, label: '≤85%' },
  { max: 0.65, mix: 52, label: '≤65%' },
  { max: 0.45, mix: 74, label: '≤45%' },
  { max: 0.3, mix: 96, label: '≤30%' },
]
function cellColor(limit: number): string {
  if (limit >= 1) return 'var(--color-raised)'
  let mix = STEPS[0].mix
  for (const step of STEPS) if (limit <= step.max + 1e-9) mix = step.mix
  return `color-mix(in oklab, var(--color-flow) ${mix}%, var(--color-raised))`
}
const HATCH = 'repeating-linear-gradient(135deg, var(--color-line) 0 2px, transparent 2px 5px)'

const pct = (v: number) => `${Math.round(v * 100)}%`
const kwh = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v >= 100 ? 0 : 1))

/**
 * Side panel for the energy saver. Which buildings can take a lower power limit,
 * and when, given how many people are in them.
 */
export function SaverPanel({ live, onClose, onChanged }: Props) {
  const [weekday, setWeekday] = useState<string>(live?.weekday ?? 'Tue')
  const [policy, setPolicy] = useState<SaverPolicy>(live?.policy ?? 'balanced')
  const [start, setStart] = useState(16 * 60)
  const [campus, setCampus] = useState('umich')
  const [campuses, setCampuses] = useState<SaverCampus[]>([])
  const [plan, setPlan] = useState<SaverPlan | null>(null)
  const [compare, setCompare] = useState<SaverCompare | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<{ row: SaverBuilding; slot: number; x: number; y: number } | null>(null)

  useEffect(() => {
    fetchSaverCampuses().then(setCampuses).catch(() => {})
  }, [])

  useEffect(() => {
    let stop = false
    fetchSaverPlan(weekday, policy, campus)
      .then((next) => !stop && (setPlan(next), setError(null)))
      .catch((e) => !stop && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      stop = true
    }
  }, [weekday, policy, campus])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rows = useMemo(() => {
    if (!plan) return []
    return plan.buildings
      .filter((b) => TYPE_ORDER.includes(b.type))
      .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || b.kwh_saved - a.kwh_saved)
  }, [plan])

  const umich = campus === 'umich'
  // The cursor follows the clock only for the plan that is running.
  const showCursor = live && umich && plan && live.policy === plan.policy && live.weekday === plan.weekday
  const running = Boolean(live)

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const t = plan?.totals

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-[22px] font-semibold">Energy saver</div>
          <p className="mt-1 text-sm leading-normal text-muted">
            Lower power limits on buildings people are not using, never below what the people inside need.
          </p>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 rounded-md border border-line px-2.5 py-[5px] text-sm text-muted transition hover:text-text">
          Back <span className="font-mono text-xs">Esc</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {/* Controls */}
        <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-4 pt-3">
          <label className="flex min-w-0 flex-col gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Campus
            <select
              value={campus}
              onChange={(e) => {
                setCampus(e.target.value)
                setCompare(null)
              }}
              className="min-w-0 rounded-md border border-line bg-ink px-2 py-1.5 text-sm font-normal normal-case tracking-normal text-text"
            >
              {(campuses.length ? campuses : [{ id: 'umich', name: 'University of Michigan', measured: true }]).map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.measured ? '' : ' (estimated)'}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Day
            <select
              value={weekday}
              onChange={(e) => {
                setWeekday(e.target.value)
                setCompare(null)
              }}
              className="rounded-md border border-line bg-ink px-2 py-1.5 text-sm font-normal normal-case tracking-normal text-text"
            >
              {WEEKDAYS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Start
            <select
              value={start}
              onChange={(e) => setStart(Number(e.target.value))}
              className="rounded-md border border-line bg-ink px-2 py-1.5 font-mono text-sm font-normal tracking-normal text-text"
            >
              {Array.from({ length: 48 }, (_, i) => i * 30).map((m) => <option key={m} value={m}>{hhmm(m)}</option>)}
            </select>
          </label>
        </div>

        <div className="px-4 pt-3" role="radiogroup" aria-label="Policy">
          <div className="grid grid-cols-3 gap-1 rounded-md border border-line bg-ink p-1">
            {SAVER_POLICIES.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={policy === p}
                onClick={() => {
                  setPolicy(p)
                }}
                className={`rounded px-2 py-1.5 text-sm font-medium transition ${policy === p ? 'bg-raised text-text shadow-sm' : 'text-muted hover:text-text'}`}
              >
                {plan?.policies[p]?.label ?? p}
              </button>
            ))}
          </div>
          {plan && <p className="mt-1.5 text-xs leading-snug text-muted">{plan.policies[policy].description}</p>}
        </div>

        {/* Live status while the saver runs on the clock */}
        {live && (
          <div className="mx-4 mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-line bg-ink px-3 py-2 font-mono text-[13px] tabular-nums">
            <span className="flex items-center gap-1.5 font-sans text-xs font-semibold uppercase tracking-[0.12em] text-text">
              <span className="h-1.5 w-1.5 rounded-full bg-flow" /> {live.policy_label} · {live.weekday} {live.clock}
            </span>
            <span className="text-muted"><span className="text-text">{live.kw_saved_now.toFixed(0)} kW</span> saved now</span>
            <span className="text-muted"><span className="text-text">{live.kwh_saved.toFixed(1)} kWh</span> so far</span>
            <span className="text-muted"><span className="text-text">{Object.keys(live.caps).length}</span> capped</span>
          </div>
        )}

        {/* Stat tiles */}
        {t && (
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line mx-4 mt-3">
            <Tile label="Saved per day" value={`${kwh(t.kwh_saved)} kWh`} sub={`${t.pct_saved}% vs always on · ${kwh(Math.max(0, t.kwh_saved_vs_timeclock))} vs a timeclock`} />
            <Tile label="Peak cut" value={`${t.peak_kw_cut.toFixed(0)} kW`} sub={`campus peak ${t.peak_kw_saver.toFixed(0)} of ${t.peak_kw_always_on.toFixed(0)} kW`} />
            <Tile label="People in capped buildings" value={fmtPeople(t.people_capped_peak)} sub={`at the peak · ${t.person_hours_capped.toLocaleString()} person-hours`} />
            <Tile label="Buildings capped" value={String(t.buildings_capped)} sub={plan?.measured ? 'busyness from the class schedule' : 'estimated from building type'} />
          </div>
        )}

        {plan && (
          <div className="mx-4 mt-3 rounded-md border-l-2 border-flow bg-ink px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">What we learned</div>
            <p className="mt-0.5 text-sm leading-snug">{plan.insight}</p>
          </div>
        )}

        {/* Heatmap: buildings by half hour */}
        {plan && (
          <div className="relative px-4 pt-4" onMouseLeave={() => setHover(null)}>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Power cap by half hour · {plan.weekday}</span>
              {!umich && <span className="text-[11px] text-muted">estimated from building type</span>}
            </div>
            <div className="relative grid grid-cols-[84px_minmax(0,1fr)] items-center gap-x-2 gap-y-[2px]">
              {rows.map((row, i) => (
                <HeatRow
                  key={row.id}
                  row={row}
                  first={i === 0 || rows[i - 1].type !== row.type}
                  name={umich ? PLACES[row.id]?.short ?? row.name : row.name}
                  onHover={(slot, x, y) => setHover({ row, slot, x, y })}
                />
              ))}
              <span />
              <div className="relative h-4 font-mono text-[10px] text-muted">
                {[0, 6, 12, 18, 24].map((h) => (
                  <span key={h} className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full" style={{ left: `${(h / 24) * 100}%` }}>
                    {String(h).padStart(2, '0')}
                  </span>
                ))}
              </div>
              {showCursor && (
                // Now-cursor over the cell column only: 84px labels plus the 8px gap.
                <div
                  className="pointer-events-none absolute top-0 bottom-0 flex w-0 flex-col items-center"
                  style={{ left: `calc(92px + (100% - 92px) * ${live!.minute / 1440})` }}
                >
                  <div className="w-0.5 flex-1 rounded-full bg-text" />
                  <span className="rounded-sm bg-text px-1 font-mono text-[10px] leading-4 text-ink">{live!.clock}</span>
                </div>
              )}
            </div>
            {hover && <Tip hover={hover} umich={umich} />}
            {/* Legend */}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
              <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-[2px] border border-line" style={{ background: 'var(--color-raised)' }} />full power</span>
              {STEPS.map((s) => (
                <span key={s.label} className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: `color-mix(in oklab, var(--color-flow) ${s.mix}%, var(--color-raised))` }} />cap {s.label}</span>
              ))}
              <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-[2px] border border-line" style={{ background: HATCH }} />never capped</span>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="grid grid-cols-3 gap-2 px-4 pt-4">
          <button
            type="button"
            disabled={!umich || busy !== null}
            title={umich ? 'Apply this plan to the live campus from the start time' : 'The live twin is U-M; other campuses are plans only'}
            onClick={() => void act('run', () => applySaver(policy, weekday, start))}
            className="rounded-md border border-branch bg-branch px-2 py-2 text-sm font-semibold text-onbranch disabled:opacity-40"
          >
            {busy === 'run' ? 'Starting…' : running ? 'Restart on clock' : 'Run on clock'}
          </button>
          <button
            type="button"
            disabled={!umich || busy !== null}
            onClick={() => void act('compare', async () => setCompare(await compareSaver(weekday, start)))}
            className="rounded-md border border-line px-2 py-2 text-sm font-medium text-text transition hover:bg-raised disabled:opacity-40"
          >
            {busy === 'compare' ? 'Running…' : 'Compare policies'}
          </button>
          <button
            type="button"
            disabled={!running || busy !== null}
            onClick={() => void act('clear', clearSaver)}
            className="rounded-md border border-line px-2 py-2 text-sm font-medium text-muted transition hover:text-text disabled:opacity-40"
          >
            Clear
          </button>
        </div>
        {!umich && <p className="px-4 pt-1.5 text-xs text-muted">Plans only: the live twin and the clock are U-M.</p>}
        {error && <p className="px-4 pt-2 text-sm text-down">{error}</p>}

        {compare && (
          <div className="mx-4 mt-3 overflow-hidden rounded-md border border-line">
            <div className="border-b border-line bg-ink px-3 py-2 text-xs text-muted">
              Each policy ran on its own copy, {compare.weekday} {compare.start} to {compare.end}. Ranked by kWh saved among policies that still meet the occupied need and serve as much essential load as off.
            </div>
            <CompareNote compare={compare} />
            {compare.branches.map((b) => (
              <div key={b.id} className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{b.label}</span>
                    {b.id === compare.winner && <span className="rounded-[3px] bg-branch px-[5px] py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-onbranch">Best</span>}
                    {!b.metrics.eligible && <span className="text-[11px] text-down">misses need</span>}
                  </div>
                  <div className="font-mono text-[12px] tabular-nums text-muted">
                    essential {pct(b.metrics.essential_served)} · {fmtPeople(b.metrics.people_dark)} dark
                  </div>
                </div>
                <span className="font-mono text-[15px] tabular-nums">{b.metrics.kwh_saved.toFixed(0)} kWh</span>
                {b.id !== 'off' && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      setPolicy(b.id as SaverPolicy)
                      void act('run', () => applySaver(b.id as SaverPolicy, weekday, live ? live.minute : start))
                    }}
                    className="rounded-md border border-line px-2 py-1 text-xs text-muted transition hover:text-text disabled:opacity-40"
                  >
                    Adopt
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {plan && (
          <details className="mx-4 my-4 rounded-md border border-line bg-ink px-3 py-2 text-sm">
            <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Assumptions</summary>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-[13px] leading-snug text-muted">
              {plan.assumptions.map((a) => <li key={a}>{a}</li>)}
            </ul>
          </details>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-panel px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{label}</div>
      <div className="mt-0.5 font-mono text-[20px] font-medium tabular-nums leading-tight">{value}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-muted">{sub}</div>
    </div>
  )
}

function HeatRow({ row, first, name, onHover }: { row: SaverBuilding; first: boolean; name: string; onHover: (slot: number, x: number, y: number) => void }) {
  return (
    <>
      <span className={`truncate text-[11px] ${first ? 'mt-1.5' : ''} ${row.managed ? 'text-text' : 'text-muted'}`} title={`${row.name} · ${TYPE_LABEL[row.type] ?? row.type} · ${row.source}`}>
        {name}
      </span>
      <div
        className={`grid h-3.5 grid-cols-[repeat(48,minmax(0,1fr))] gap-px ${first ? 'mt-1.5' : ''}`}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          const slot = Math.max(0, Math.min(47, Math.floor(((e.clientX - box.left) / box.width) * 48)))
          const parent = e.currentTarget.offsetParent?.getBoundingClientRect()
          onHover(slot, e.clientX - (parent?.left ?? 0), box.top - (parent?.top ?? 0))
        }}
        role="img"
        aria-label={`${row.name}: ${row.never ? 'never capped' : `lowest cap ${pct(Math.min(...row.limit))}`}`}
      >
        {row.limit.map((limit, slot) => (
          <span
            key={slot}
            className={`${slot % 2 === 0 ? 'rounded-l-[1px]' : 'rounded-r-[1px]'}`}
            style={{ background: row.never ? HATCH : cellColor(limit) }}
          />
        ))}
      </div>
    </>
  )
}

function Tip({ hover, umich }: { hover: { row: SaverBuilding; slot: number; x: number; y: number }; umich: boolean }) {
  const { row, slot } = hover
  const name = umich ? PLACES[row.id]?.short ?? row.name : row.name
  const time = hhmm(slot * 30)
  const people = fmtPeople(row.people[slot])
  const text = row.never
    ? `${name} ${time} · ${people} people · never capped`
    : row.limit[slot] < 1
      ? `${name} ${time} · ${people} people · cap ${pct(row.limit[slot])} (need ${pct(row.need[slot])})`
      : `${name} ${time} · ${people} people · full power${row.managed ? ` (need ${pct(row.need[slot])})` : ', not managed by this policy'}`
  return (
    <div
      className="pointer-events-none absolute z-10 w-max max-w-[260px] -translate-x-1/2 -translate-y-full rounded-md border border-line bg-raised px-2 py-1 text-[12px] leading-snug shadow-lg"
      style={{ left: Math.max(136, Math.min(hover.x, 262)), top: hover.y - 4 }}
    >
      <div className="font-medium">{text}</div>
      <div className="text-[11px] text-muted">{row.source}</div>
    </div>
  )
}

/** One line on what the comparison showed, from its numbers. */
function CompareNote({ compare }: { compare: SaverCompare }) {
  const off = compare.branches.find((b) => b.id === 'off')
  const best = compare.branches.find((b) => b.id === compare.winner)
  if (!off || !best || best.id === 'off') return null
  const gain = best.metrics.essential_served - off.metrics.essential_served
  const text =
    gain > 0.001
      ? `Caps also free supply: essential load served ${pct(best.metrics.essential_served)} under ${best.label}, ${pct(off.metrics.essential_served)} with the saver off.`
      : `${best.label} saves ${best.metrics.kwh_saved.toFixed(0)} kWh by 23:30 with essential load as well served as with the saver off.`
  return <p className="border-b border-line px-3 py-2 text-sm leading-snug">{text}</p>
}
