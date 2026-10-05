import { useEffect, useState } from 'react'

import type { RepoSummary } from '../../../shared/api'

/**
 * Working-tree summary for a project folder. Re-read when `refreshKey`
 * changes (a run settled, a shell command finished) and when the window
 * regains focus or a branch changes — never on a timer.
 */
export function useRepoSummary(cwd: string | null, refreshKey: unknown): RepoSummary | null {
  const [state, setState] = useState<{ cwd: string; summary: RepoSummary } | null>(null)
  useEffect(() => {
    if (!cwd) {
      return
    }
    let cancelled = false
    const load = () => {
      void window.piDesktop.diff
        .summary({ cwd })
        .then((summary) => {
          if (!cancelled) {
            setState({ cwd, summary })
          }
        })
        .catch(() => {})
    }
    load()
    window.addEventListener('focus', load)
    // A branch switched from the menu, another window or a phone.
    const off = window.piDesktop.git.onChanged(load)
    return () => {
      cancelled = true
      window.removeEventListener('focus', load)
      off()
    }
  }, [cwd, refreshKey])
  return cwd && state?.cwd === cwd ? state.summary : null
}
