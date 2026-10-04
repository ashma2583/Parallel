import { WEEKDAYS, type ClassLoadState } from '../lib/classLoad'

const fmt = (n: number) => n.toLocaleString()

/** Estimated students in class by time of day, from the class schedule and campus events. */
export function ClassLoad({ load }: { load: ClassLoadState }) {
  const { data, loading, error, weekday, setWeekday, turnup, setTurnup, slot, setSlot, following } = load
  const selected = data?.slots[slot]
  const ranked = data
    ? data.buildings
        .map((b) => ({ ...b, now: b.students[slot] ?? 0 }))
        .filter((b) => b.now > 0)
        .sort((a, b) => b.now - a.now)
    : []
  const peak = data ? Math.max(1, ...data.slots.map((s) => s.students)) : 1
  const last = data ? Math.max(0, data.slots.length - 1) : 0

  return (
    <section className="flex flex-col gap-3">
      <p className="text-xs leading-[1.55] text-muted">
        Students in class from the {data?.term_name ?? 'Fall 2026'} schedule at {Math.round(turnup * 100)}% turnup, plus
        estimated crowds at campus events. Shown on the map as circles and on building pins. Used by the agents: occupancy follows
        the class schedule, so the energy agent, the transit agent, the briefing and Branch all count the students in each building.
      </p>
      {load.clock?.following && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-people" />
          Following the scenario clock while it runs.
        </p>
      )}

      <div className="flex gap-1" role="group" aria-label="Weekday">
        {WEEKDAYS.map((day) => (
          <button
            key={day}
            type="button"
            onClick={() => setWeekday(day)}
            aria-pressed={weekday === day}
            className={`flex-1 rounded px-1 py-1 text-[11px] font-semibold ${
              weekday === day ? 'bg-people text-ink' : 'bg-raised text-muted hover:text-text'
            }`}
          >
            {day}
          </button>
        ))}
      </div>

      {loading && !data && <p className="text-xs text-muted">Reading the schedule of classes…</p>}
      {error && <p className="text-xs leading-snug text-down">{error}</p>}

      {data && selected && (
        <>
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-[15px] font-semibold">
                {data.weekday} {selected.label}
              </span>
              <span className="font-mono text-[13px] tabular-nums text-people">{fmt(selected.students)} people</span>
            </div>
            {/* The day at a glance. A bar picks its slot. */}
            <div className="mt-2 flex h-12 items-end gap-px">
              {data.slots.map((s, index) => (
                <button
                  key={s.minutes}
                  type="button"
                  title={`${s.label}: ${fmt(s.students)}`}
                  aria-label={`${s.label}, ${fmt(s.students)} people`}
                  onClick={() => setSlot(index)}
                  disabled={following}
                  className={`min-w-0 flex-1 rounded-sm ${index === slot ? 'bg-people' : following ? 'bg-line' : 'bg-line hover:bg-muted'}`}
                  style={{ height: `${Math.max(8, (s.students / peak) * 100)}%` }}
                />
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={last}
              value={slot}
              onChange={(event) => setSlot(Number(event.target.value))}
              aria-label="Time of day"
              disabled={following}
              className="mt-1.5 w-full accent-[var(--color-people)]"
            />
            <div className="flex justify-between font-mono text-[10px] text-faint">
              <span>{data.slots[0]?.label}</span>
              <span>{data.slots[last]?.label}</span>
            </div>
            {following && <p className="mt-1.5 text-[11px] leading-snug text-people">Following the simulation clock in the top bar while the scenario runs. Scrub again once it ends.</p>}
            {selected.events ? (
              <p className="mt-1.5 text-[11px] text-muted">Includes {fmt(selected.events)} at campus events.</p>
            ) : null}
            {/* The note explains the opening slot, so it goes once the user scrubs away. */}
            {data.note && slot === data.focus && <p className="mt-1.5 text-[11px] leading-snug text-muted">{data.note}</p>}
          </div>

          <div>
            <label htmlFor="class-turnup" className="flex items-center justify-between text-[11px] text-muted">
              <span>Turnup</span>
              <span className="font-mono tabular-nums text-text">{Math.round(turnup * 100)}%</span>
            </label>
            <input
              id="class-turnup"
              type="range"
              min={0.4}
              max={1}
              step={0.05}
              value={turnup}
              onChange={(event) => setTurnup(Number(event.target.value))}
              className="w-full accent-[var(--color-people)]"
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              <span>Busiest buildings</span>
              <span className="truncate font-normal normal-case tracking-normal text-faint">{data.source_label}</span>
            </div>
            {ranked.length === 0 ? (
              <p className="text-xs text-muted">No classes meet at this time.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {ranked.slice(0, 8).map((b) => (
                  <li key={b.code} className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="truncate">
                      {b.name}
                      {b.lat == null && <span className="text-faint"> · off map</span>}
                    </span>
                    <span className="shrink-0 font-mono tabular-nums text-people">{fmt(b.now)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  )
}
