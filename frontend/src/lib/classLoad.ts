import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchClassLoad, type ClassLoad, type ClassSpot } from './api'

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/** The slot on show, for the map's time chip. */
export interface ClassClock {
  slot: number
  count: number
  label: string
  students: number
  /** Busiest building at any slot of the day, so circle sizes hold still while scrubbing. */
  dayPeak: number
}

export interface ClassLoadState {
  data: ClassLoad | null
  loading: boolean
  error: string | null
  weekday: string | undefined
  setWeekday: (day: string) => void
  /** Shown at once; the fetch waits until the slider settles. */
  turnup: number
  setTurnup: (value: number) => void
  slot: number
  setSlot: (slot: number) => void
  spots: ClassSpot[]
  clock: ClassClock | null
}

/**
 * Students in class by building and time of day, from the Fall 2026 schedule and campus events.
 * Owned by App so it outlives the panel that shows it. Display only: nothing is written to the engine.
 */
export function useClassLoad(): ClassLoadState {
  const [weekday, setWeekday] = useState<string | undefined>(undefined)
  const [turnup, setTurnup] = useState(0.75)
  const [query, setQuery] = useState(0.75)
  const [data, setData] = useState<ClassLoad | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [slot, setSlotRaw] = useState(0)
  const seeded = useRef(false)
  // Bumped to try again when the engine was not up yet.
  const [attempt, setAttempt] = useState(0)

  // Each turnup step would refetch about half a megabyte, so wait for the slider to settle.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(turnup), 250)
    return () => window.clearTimeout(timer)
  }, [turnup])

  useEffect(() => {
    let stop = false
    let retry = 0
    setLoading(true)
    setError(null)
    fetchClassLoad(weekday, query)
      .then((next) => {
        if (stop) return
        setData(next)
        // Open on the slot the engine picks (now, or the day's peak) once; after that the user's slot stays.
        if (!seeded.current) {
          seeded.current = true
          setSlotRaw(next.focus)
        }
      })
      .catch((err: unknown) => {
        if (stop) return
        setError(err instanceof Error ? err.message : String(err))
        retry = window.setTimeout(() => setAttempt((n) => n + 1), 5000)
      })
      .finally(() => {
        if (!stop) setLoading(false)
      })
    return () => {
      stop = true
      window.clearTimeout(retry)
    }
  }, [weekday, query, attempt])

  const count = data?.slots.length ?? 0
  const shown = count ? Math.min(Math.max(0, slot), count - 1) : 0

  const spots = useMemo(() => {
    if (!data) return []
    const out: ClassSpot[] = []
    for (const b of data.buildings) {
      const students = b.students[shown] ?? 0
      if (students <= 0 || b.lat == null || b.lng == null) continue
      out.push({ code: b.code, name: b.name, lat: b.lat, lng: b.lng, nodeId: b.node_id, students })
    }
    return out
  }, [data, shown])

  const dayPeak = useMemo(
    () => (data ? Math.max(1, ...data.buildings.map((b) => Math.max(0, ...b.students))) : 1),
    [data],
  )

  const clock = useMemo<ClassClock | null>(() => {
    const at = data?.slots[shown]
    if (!data || !at) return null
    return { slot: shown, count, label: `${data.weekday} ${at.label}`, students: at.students, dayPeak }
  }, [data, shown, count, dayPeak])

  return {
    data,
    loading,
    error,
    weekday: weekday ?? data?.weekday,
    setWeekday,
    turnup,
    setTurnup,
    slot: shown,
    setSlot: (next: number) => setSlotRaw(count ? Math.min(Math.max(0, next), count - 1) : next),
    spots,
    clock,
  }
}
