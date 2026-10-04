import { useSyncExternalStore } from 'react'
import { AppState } from 'react-native'

/**
 * One shared 1 Hz clock for every live indicator (blinking status pixels,
 * elapsed times). It only ticks while something is subscribed and the app is
 * in the foreground, so an idle screen schedules no timers at all — the
 * phone-side twin of the desktop's lib/live-clock.ts.
 */
const subscribers = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let tick = 0

function start(): void {
  if (!timer && subscribers.size > 0 && AppState.currentState === 'active') {
    timer = setInterval(() => {
      tick++
      for (const subscriber of subscribers) {
        subscriber()
      }
    }, 1000)
  }
}

function stop(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    start()
  } else {
    stop()
  }
})

function subscribe(callback: () => void): () => void {
  subscribers.add(callback)
  start()
  return () => {
    subscribers.delete(callback)
    if (subscribers.size === 0) {
      stop()
    }
  }
}

const idle = (): (() => void) => () => {}

/** The current tick; re-renders once a second while `live` is true. */
export function useTick(live = true): number {
  return useSyncExternalStore(live ? subscribe : idle, () => tick)
}

/** "0:42", "12:05", "1:02:03" since a wall-clock start. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}
