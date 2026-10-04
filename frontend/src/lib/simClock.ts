import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseClock } from './weather/plan'
import { TICK_MINUTES } from './weather/types'

/** The sim opens on a hot afternoon. */
const OPEN_MINUTES = 14 * 60

/** From this tick on, the clock reads `minutes` and moves `perTick` minutes a tick. */
interface Segment {
  tick: number
  minutes: number
  perTick: number
}

export interface SimClockInput {
  /** The engine's tick. */
  tick: number | undefined
  /** A scenario playing on the map: its start time and run speed. */
  run: { startsAt: string; speed: number } | null
  /** The heat wave in the briefing, if one is on. */
  wave: { step: number; span: number } | null
}

export interface SimClock {
  /** Time of day now, "HH:MM", or a dash before the engine reports a tick. */
  label: string
  /** Minutes into the day now, or null before the engine reports a tick. */
  minutes: number | null
  /** A scenario or heat wave is moving the clock, so other views follow it instead of scrubbing. */
  following: boolean
  /** Time of day at a tick, for feed lines and forks. */
  at: (tick: number) => string
  /** The tick nearest a typed "HH:MM" within twelve hours of now, or null if it is not a time. */
  tickFor: (time: string) => number | null
}

export function fmtClock(minutes: number): string {
  const day = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(day / 60)).padStart(2, '0')}:${String(day % 60).padStart(2, '0')}`
}

const read = (segments: Segment[], tick: number) => {
  let seg = segments[0]
  for (const next of segments) if (next.tick <= tick) seg = next
  return seg.minutes + (tick - seg.tick) * seg.perTick
}

/**
 * The one time-of-day clock. A tick is four minutes; the day opens at 14:00. A scenario run
 * starts it at the run's start time and moves at the run's speed, and a heat wave starts it at
 * 14:00. Everything that shows a time reads it from here.
 */
export function useSimClock({ tick, run, wave }: SimClockInput): SimClock {
  const [segments, setSegments] = useState<Segment[]>([])
  const tickRef = useRef(tick)
  useEffect(() => {
    tickRef.current = tick
  })

  useEffect(() => {
    if (tick === undefined) return
    setSegments((s) => (s.length ? s : [{ tick, minutes: OPEN_MINUTES, perTick: TICK_MINUTES }]))
  }, [tick])

  // A run starts the clock at its start time. A change of speed or the end of the run only changes the pace.
  const running = run !== null
  const speed = run?.speed ?? 1
  const startsAt = run?.startsAt
  const before = useRef({ running: false, speed: 1 })
  useEffect(() => {
    const was = before.current
    before.current = { running, speed }
    const now = tickRef.current
    if (now === undefined || (running === was.running && speed === was.speed)) return
    const parsed = running && !was.running ? parseClock(startsAt ?? '') : null
    setSegments((s) => {
      const here = s.length ? read(s, now) : OPEN_MINUTES
      const minutes = running && !was.running ? (parsed ? parsed[0] * 60 + parsed[1] : OPEN_MINUTES) : here
      return [...s.slice(-40), { tick: now, minutes, perTick: TICK_MINUTES * (running ? speed : 1) }]
    })
  }, [running, speed, startsAt])

  // A heat wave outside a run starts at 14:00. The step tells where it began, so a reload mid-wave still reads right.
  const step = wave?.step
  const seen = useRef<number | null>(null)
  useEffect(() => {
    const last = seen.current
    seen.current = step ?? null
    const now = tickRef.current
    if (step === undefined || now === undefined || running) return
    if (last === null || step < last) setSegments([{ tick: now - step, minutes: OPEN_MINUTES, perTick: TICK_MINUTES }])
  }, [step, running])

  const waving = wave !== null && wave.step < wave.span
  const minutes = tick !== undefined && segments.length ? read(segments, tick) : null

  const at = useCallback((t: number) => (segments.length ? fmtClock(read(segments, t)) : '—'), [segments])
  const tickFor = useCallback(
    (time: string) => {
      const parsed = parseClock(time)
      if (!parsed || tick === undefined || minutes === null) return null
      const delta = ((((parsed[0] * 60 + parsed[1] - minutes + 720) % 1440) + 1440) % 1440) - 720
      const perTick = segments[segments.length - 1]?.perTick ?? TICK_MINUTES
      return tick + Math.round(delta / perTick)
    },
    [tick, minutes, segments],
  )

  return useMemo(
    () => ({ label: minutes === null ? '—' : fmtClock(minutes), minutes, following: running || waving, at, tickFor }),
    [minutes, running, waving, at, tickFor],
  )
}
