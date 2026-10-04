import { useEffect, useState } from 'react'
import { fetchPeopleNow, type PeopleNow } from './api'

/** The engine's own count of students in class, by building, refreshed while a building is open. */
export function usePeopleNow(active: boolean): PeopleNow | null {
  const [now, setNow] = useState<PeopleNow | null>(null)
  useEffect(() => {
    if (!active) return
    let stop = false
    const pull = () => {
      void fetchPeopleNow().then((next) => {
        if (!stop) setNow(next)
      })
    }
    pull()
    const timer = window.setInterval(pull, 2000)
    return () => {
      stop = true
      window.clearInterval(timer)
    }
  }, [active])
  return now
}
