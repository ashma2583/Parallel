import { useEffect, useState } from 'react'
import { fetchClassLoad, type ClassLoad as ClassLoadData, type ClassSpot } from '../lib/api'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

interface Props {
  onSpots: (spots: ClassSpot[]) => void
  slot: number
  onSlot: (slot: number) => void
  onClock: (clock: { count: number; label: string; students: number; dayPeak: number } | null) => void
}

/** Estimated students in class, from capacity and a turnup rate. */
export function ClassLoad({ onSpots, slot, onSlot, onClock }: Props) {
  const [weekday, setWeekday] = useState<string | undefined>(undefined)
  const [turnup, setTurnup] = useState(0.75)
  const [data, setData] = useState<ClassLoadData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stop = false
    setLoading(true)
    setError(null)
    fetchClassLoad(weekday, turnup)
      .then((next) => {
        if (stop) return
        setData(next)
        onSlot(next.focus)
      })
      .catch((err: unknown) => {
        if (stop) return
        setData(null)
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!stop) setLoading(false)
      })
    return () => {
      stop = true
    }
  }, [weekday, turnup, onSlot])

  useEffect(() => {
    if (!data) {
      onSpots([])
      return
    }
    const spots: ClassSpot[] = []
    for (const building of data.buildings) {
      const students = building.students[slot] ?? 0
      if (students <= 0 || building.lat == null || building.lng == null) continue
      spots.push({
        code: building.code,
        name: building.name,
        lat: building.lat,
        lng: building.lng,
        nodeId: building.node_id,
        students,
      })
    }
    onSpots(spots)
    const selectedSlot = data.slots[slot]
    const dayPeak = Math.max(1, ...data.buildings.map((building) => Math.max(0, ...building.students)))
    onClock(
      selectedSlot
        ? { count: data.slots.length, label: `${data.weekday} ${selectedSlot.label}`, students: selectedSlot.students, dayPeak }
        : null,
    )
  }, [data, slot, onSpots, onClock])

  const selected = data?.slots[slot]
  const ranked = data
    ? [...data.buildings]
        .map((building) => ({ ...building, now: building.students[slot] ?? 0 }))
        .filter((building) => building.now > 0)
        .sort((a, b) => b.now - a.now)
    : []
  const peak = data ? Math.max(...data.slots.map((item) => item.students), 1) : 1

  return (
    <section>
      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Class load</h2>
      <p className="mb-2 text-[11px] leading-snug text-slate-400">
        Class seats use a {Math.round(turnup * 100)}% turnup. Campus events add an estimated crowd from Happening @ Michigan.
      </p>
      <div className="mb-2 flex flex-wrap gap-1">
        {DAYS.map((day) => (
          <button
            key={day}
            type="button"
            onClick={() => setWeekday(day)}
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              (weekday ?? data?.weekday) === day ? 'bg-amber-300 text-slate-950' : 'bg-slate-900 text-slate-300'
            }`}
          >
            {day}
          </button>
        ))}
      </div>
      {loading && !data && <p className="text-xs text-slate-500">Reading the schedule of classes…</p>}
      {error && <p className="text-xs leading-snug text-red-300">{error}</p>}
      {data && selected && (
        <>
          <div className="mb-1 flex items-baseline justify-between text-xs">
            <span className="font-semibold text-slate-100">
              {data.weekday} {selected.label}
            </span>
            <span className="font-mono text-amber-200">{selected.students.toLocaleString()} people</span>
          </div>
          <div className="flex h-10 items-end gap-px">
            {data.slots.map((item, index) => (
              <button
                key={item.minutes}
                type="button"
                title={`${item.label}: ${item.students.toLocaleString()}`}
                onClick={() => onSlot(index)}
                className="min-w-0 flex-1 rounded-sm"
                style={{
                  height: `${Math.max(8, (item.students / peak) * 100)}%`,
                  background: index === slot ? '#FFCB05' : '#334155',
                }}
              />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(0, data.slots.length - 1)}
            value={slot}
            onChange={(event) => onSlot(Number(event.target.value))}
            aria-label="Time of day"
            className="mt-1 w-full"
          />
          {selected.events ? (
            <p className="mt-1 text-[11px] leading-snug text-slate-400">
              Includes {selected.events.toLocaleString()} at campus events.
            </p>
          ) : null}
          {data.note && <p className="mt-1 text-[11px] leading-snug text-slate-400">{data.note}</p>}
          <label className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
            <span>Turnup</span>
            <span className="font-mono">{Math.round(turnup * 100)}%</span>
          </label>
          <input
            type="range"
            min={0.4}
            max={1}
            step={0.05}
            value={turnup}
            onChange={(event) => setTurnup(Number(event.target.value))}
            aria-label="Class turnup rate"
            className="w-full"
          />
          <p className="mt-2 text-[10px] uppercase tracking-wider text-slate-500">
            {data.term_name} · {data.source_label}
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {ranked.slice(0, 8).map((building) => (
              <li key={building.code} className="flex items-baseline justify-between gap-2 text-xs text-slate-200">
                <span className="truncate">
                  {building.name}
                  {building.lat == null && <span className="text-slate-500"> · off map</span>}
                </span>
                <span className="shrink-0 font-mono text-amber-200">{building.now.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
