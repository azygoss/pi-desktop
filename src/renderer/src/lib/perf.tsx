import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react'

/**
 * Dev-only commit counter, active when the app was launched with
 * PI_DESKTOP_PERF=1 (scripts/perf.mjs sets it). Commits are tallied per
 * profiler id on window.__piCommits for the harness to read.
 */
const ENABLED = window.piDesktop?.perfEnabled === true

const onRender: ProfilerOnRenderCallback = (id) => {
  const w = window as unknown as { __piCommits?: Record<string, number> }
  const commits = (w.__piCommits ??= {})
  commits[id] = (commits[id] ?? 0) + 1
}

export function Perf({ id, children }: { id: string; children: ReactNode }) {
  if (!ENABLED) {
    return <>{children}</>
  }
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  )
}
