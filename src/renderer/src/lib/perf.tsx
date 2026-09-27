import type { ReactNode } from 'react'

/**
 * Dev-only commit counter, active when the app was launched with
 * PI_DESKTOP_PERF=1 (scripts/perf.mjs sets it). Each render of a wrapped
 * subtree increments window.__piCommits[id]; the harness reads the totals
 * after a measured phase. (React's own <Profiler> only fires callbacks in
 * the react-dom/profiling bundle, so counting inside render is the way to
 * get per-component commit counts in a normal production build.)
 */
const ENABLED = window.piDesktop?.perfEnabled === true

export function Perf({ id, children }: { id: string; children: ReactNode }) {
  if (ENABLED) {
    const w = window as unknown as { __piCommits?: Record<string, number> }
    const commits = (w.__piCommits ??= {})
    commits[id] = (commits[id] ?? 0) + 1
  }
  return <>{children}</>
}
