import { useCallback, useEffect, useState } from 'react'
import { create } from 'zustand'

import {
  fixChecksPrompt,
  summarizeChecks,
  type PrStatus,
  type PrSummary,
  type PullRequest
} from '../../../shared/pr-status'

/** Checks are re-read this often while any of them is still running. */
const PENDING_POLL_MS = 60_000
/** The header chip and the panel ask at the same moments; one `gh` serves both. */
const FRESH_MS = 3000

const cache = new Map<string, { at: number; request: Promise<PrStatus> }>()

/** Read the pull request for `cwd`, sharing a request made moments ago. */
export function fetchPrStatus(cwd: string, force = false): Promise<PrStatus> {
  const cached = cache.get(cwd)
  if (!force && cached && Date.now() - cached.at < FRESH_MS) {
    return cached.request
  }
  const request = window.piDesktop.pr.status({ cwd })
  cache.set(cwd, { at: Date.now(), request })
  request.catch(() => cache.delete(cwd))
  return request
}

interface PrMonitorState {
  /** Chats with "fix failing checks automatically" on (this app run only). */
  autoFix: Record<string, boolean>
  setAutoFix(chatId: string, on: boolean): void
}

export const usePrMonitorStore = create<PrMonitorState>((set) => ({
  autoFix: {},
  setAutoFix(chatId, on) {
    set((s) => ({ autoFix: { ...s.autoFix, [chatId]: on } }))
  }
}))

/** Build the fix prompt, with the failed job's log tail when there is one. */
export async function buildFixPrompt(cwd: string, pr: PullRequest): Promise<string> {
  const runId = pr.checks.find((c) => c.state === 'fail' && c.runId)?.runId
  const log = runId ? await window.piDesktop.pr.failedLog({ cwd, runId }).catch(() => '') : ''
  return fixChecksPrompt(pr, log)
}

export interface PrMonitor {
  /** Null until the first answer for this folder. */
  status: PrStatus | null
  pr: PullRequest | undefined
  summary: PrSummary
  reload(): void
}

/**
 * Pull request of the branch checked out in `cwd`. Re-read when `refreshKey`
 * changes (a run settled, the branch changed), when the window regains
 * focus, and once a minute only while checks are still running.
 */
export function usePrStatus(cwd: string | null, refreshKey: unknown): PrMonitor {
  const [state, setState] = useState<{ cwd: string; status: PrStatus } | null>(null)

  const load = useCallback(
    (force = false) => {
      if (!cwd) {
        return
      }
      void fetchPrStatus(cwd, force)
        .then((status) => setState({ cwd, status }))
        .catch(() => {})
    },
    [cwd]
  )

  useEffect(() => {
    const timer = setTimeout(() => load(), 0)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [load, refreshKey])

  const status = cwd && state?.cwd === cwd ? state.status : null
  const pr = status?.pr
  const summary = pr ? summarizeChecks(pr.checks) : 'none'

  useEffect(() => {
    if (summary !== 'pending') {
      return
    }
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        load()
      }
    }, PENDING_POLL_MS)
    return () => clearInterval(timer)
  }, [summary, load])

  const reload = useCallback(() => load(true), [load])
  return { status, pr, summary, reload }
}
