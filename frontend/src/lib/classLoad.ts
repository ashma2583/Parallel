import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchClassLoad, selectPeople, type ClassLoad, type ClassSpot } from './api'

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/** The slot on show, for the map's time chip. */
export interface ClassClock {
  slot: number
  count: number
  label: string
  students: number
  /** Busiest building at any slot of the day, so circle sizes hold still while scrubbing. */
  dayPeak: number
  /** A running scenario or heat wave is moving the clock. */
  following: boolean
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
  /** Students in class at the shown slot, by simulation node. Only nodes with classes that day are keys. */
  byNode: Record<string, number>
  /** The sim clock is moving (a scenario or heat wave runs), so the slot follows it. */
  following: boolean
}

/**
 * Students in class by building and time of day, from the Fall 2026 schedule and campus events.
 * Owned by App so it outlives the panel that shows it. The engine uses the same schedule to set who is in each
 * building, so the weekday and turnup chosen here are sent to it; the slot on show is only the view.
 */
export function useClassLoad(followAt: number | null = null, moving = false, jump?: (minutes: number) => void): ClassLoadState {
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
    void selectPeople(weekday, query)
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

  // Show the slot that holds the clock's minute of the day. Before the first class or after the last, none.
  useEffect(() => {
    if (followAt == null || !data || !data.slots.length) return
    const step = data.slots.length > 1 ? data.slots[1].minutes - data.slots[0].minutes : 30
    const day = ((followAt % 1440) + 1440) % 1440
    let index = -1
    data.slots.forEach((s, i) => {
      if (s.minutes <= day) index = i
    })
    if (index >= 0 && day >= data.slots[index].minutes + step) index = -1
    setSlotRaw(index)
  }, [followAt, data])

  const count = data?.slots.length ?? 0
  // -1: the clock is outside class hours, so nobody is in class.
  const shown = count ? (slot < 0 ? -1 : Math.min(slot, count - 1)) : 0

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
    if (!data || !count) return null
    const at = data.slots[shown]
    if (!at) {
      const day = followAt == null ? 0 : ((Math.round(followAt) % 1440) + 1440) % 1440
      const label = `${Math.floor(day / 60) % 12 || 12}:${String(day % 60).padStart(2, '0')} ${day < 720 ? 'AM' : 'PM'}`
      return { slot: shown, count, label: `${data.weekday} ${label}`, students: 0, dayPeak, following: moving }
    }
    return { slot: shown, count, label: `${data.weekday} ${at.label}`, students: at.students, dayPeak, following: moving }
  }, [data, shown, count, dayPeak, followAt, moving])

  const byNode = useMemo(() => {
    const out: Record<string, number> = {}
    for (const b of data?.buildings ?? []) {
      if (!b.node_id || !b.students.some((n) => n > 0)) continue
      out[b.node_id] = (out[b.node_id] ?? 0) + (b.students[shown] ?? 0)
    }
    return out
  }, [data, shown])

  return {
    data,
    loading,
    error,
    weekday: weekday ?? data?.weekday,
    setWeekday,
    turnup,
    setTurnup,
    slot: shown,
    setSlot: (next: number) => {
      const index = count ? Math.min(Math.max(0, next), count - 1) : next
      setSlotRaw(index)
      // The slot is a view of the clock: picking one moves the clock to it.
      const at = data?.slots[index]
      if (jump && at) jump(at.minutes)
    },
    spots,
    clock,
    byNode,
    following: moving,
  }
}

/** Scenario clocks start at 14:00, the heat wave's afternoon. Minute of the day. */
export const SCENARIO_START = 14 * 60
