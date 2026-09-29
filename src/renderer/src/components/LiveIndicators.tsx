import { formatElapsed, useLiveBlink, useLiveNow } from '../lib/live-clock'

/**
 * A status dot that blinks on the shared 1Hz clock (see lib/live-clock.ts);
 * the look comes from `className` (live-dot, input-dot, …).
 */
export function LiveDot({ className, title }: { className: string; title?: string }) {
  useLiveBlink(true)
  return <span className={className} title={title} aria-hidden={title ? undefined : true} />
}

/** Time elapsed since `since` ("12s", "2m 05s"), refreshed once a second. */
export function Elapsed({ since }: { since?: number }) {
  const now = useLiveNow(since !== undefined)
  if (since === undefined) {
    return null
  }
  return <span className="elapsed">{formatElapsed(now - since)}</span>
}
