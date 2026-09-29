import { useEffect, useSyncExternalStore } from 'react'

/**
 * One app-wide 1Hz clock for every live indicator (elapsed timers, the
 * blinking "working" dots).
 *
 * Why not CSS animations: on macOS every repaint keeps Chromium producing
 * frames for ~0.3s, so a 7px opacity pulse, a spinner or a shimmer each cost
 * 10–30% CPU for as long as an agent runs. Ticks here are aligned to wall-clock
 * seconds, so every indicator on screen changes in the same single frame —
 * about 1% CPU regardless of how many are visible — and the clock stops
 * entirely while nothing live is mounted or the window is hidden.
 *
 * Blinking is pure CSS keyed off `html[data-live-tick]` (see index.css), so
 * dots blink without re-rendering React; timers re-render via useLiveNow().
 */

const TICK_MS = 1000

let users = 0
let timer: ReturnType<typeof setTimeout> | null = null
let now = Date.now()
const listeners = new Set<() => void>()

function tick(): void {
  timer = null
  if (users === 0) {
    return
  }
  if (document.visibilityState === 'visible') {
    now = Date.now()
    document.documentElement.dataset['liveTick'] = String(Math.round(now / TICK_MS) % 2)
    for (const listener of listeners) {
      listener()
    }
  }
  schedule()
}

function schedule(): void {
  if (timer === null) {
    timer = setTimeout(tick, TICK_MS - (Date.now() % TICK_MS) + 2)
  }
}

function acquire(): () => void {
  users += 1
  now = Date.now()
  schedule()
  return () => {
    users -= 1
    if (users === 0) {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      delete document.documentElement.dataset['liveTick']
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const release = acquire()
  return () => {
    listeners.delete(listener)
    release()
  }
}

const noopSubscribe = () => () => {}
const getNow = () => now

/** Keeps the shared clock (and CSS blink) running while `active`. */
export function useLiveBlink(active: boolean): void {
  useEffect(() => (active ? acquire() : undefined), [active])
}

/** Wall-clock ms, refreshed once per second while `active`. */
export function useLiveNow(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : noopSubscribe, getNow)
}

/** "7s", "2m 05s", "1h 04m" — compact elapsed time for live indicators. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) {
    return `${total}s`
  }
  const minutes = Math.floor(total / 60)
  if (minutes < 60) {
    return `${minutes}m ${String(total % 60).padStart(2, '0')}s`
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
