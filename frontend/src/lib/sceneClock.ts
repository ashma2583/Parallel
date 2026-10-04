/**
 * Scenario time: wall time that stands still while the campus clock is paused.
 * Moving buses and a playing scenario read it, so Pause stops them with the clock.
 */
let pausedAt: number | null = null
let held = 0
const listeners = new Set<(paused: boolean) => void>()

/** Milliseconds, like performance.now(), minus the time spent paused. */
export function sceneNow(): number {
  return (pausedAt ?? performance.now()) - held
}

export function scenePaused(): boolean {
  return pausedAt !== null
}

export function setScenePaused(next: boolean): void {
  if (next === (pausedAt !== null)) return
  if (next) pausedAt = performance.now()
  else {
    held += performance.now() - (pausedAt ?? performance.now())
    pausedAt = null
  }
  for (const fn of listeners) fn(next)
}

/** Called with the new state each time scenario time stops or starts. Returns the unsubscribe. */
export function onScenePause(fn: (paused: boolean) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
