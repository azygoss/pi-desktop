import { Check, ExternalLink, GitPullRequest, Minus, Wrench, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'

import {
  fixChecksPrompt,
  summarizeChecks,
  type PrStatus,
  type PullRequest
} from '../../../shared/pr-status'
import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { openInBrowser } from '../state/panel-store'
import { toast } from '../state/toast-store'
import { LiveDot } from './LiveIndicators'

/** Checks are re-read this often while any of them is still running. */
const PENDING_POLL_MS = 60_000

/** Chats with "fix failures automatically" on (kept for this app run). */
const autoFixChats = new Set<string>()
/** `chatId:headSha` pairs already handed to pi, so a commit is fixed once. */
const autoFixed = new Set<string>()

/** Build the fix prompt, with the failed job's log tail when there is one. */
async function buildFixPrompt(cwd: string, pr: PullRequest): Promise<string> {
  const runId = pr.checks.find((c) => c.state === 'fail' && c.runId)?.runId
  const log = runId
    ? await window.piDesktop.pr.failedLog({ cwd, runId }).catch(() => '')
    : ''
  return fixChecksPrompt(pr, log)
}

function notify(chatId: string, title: string, body: string): void {
  if (useAppStore.getState().appSettings.notifications?.enabled === false || document.hasFocus()) {
    return
  }
  void window.piDesktop.app.notify({ chatId, title, body }).catch(() => {})
}

/**
 * The pull request of the project's current branch: number and check state
 * in the chat header, details and "Ask pi to fix" in a popover. Checks are
 * polled once a minute only while some are still running, and re-read when
 * a run settles or the window regains focus.
 */
export function PrChip({
  chatId,
  cwd,
  refreshKey
}: {
  chatId: string
  cwd: string
  refreshKey: unknown
}) {
  const [state, setState] = useState<{ cwd: string; status: PrStatus } | null>(null)
  const [open, setOpen] = useState(false)
  const [autoFix, setAutoFix] = useState(() => autoFixChats.has(chatId))
  const [busy, setBusy] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  // The last summary seen per head commit, to notice pending → done.
  const lastSeen = useRef<{ sha: string; summary: string } | null>(null)

  const load = useCallback(() => {
    void window.piDesktop.pr
      .status({ cwd })
      .then((status) => setState({ cwd, status }))
      .catch(() => {})
  }, [cwd])

  useEffect(() => {
    const timer = setTimeout(load, 0)
    window.addEventListener('focus', load)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', load)
    }
  }, [load, refreshKey])

  const pr = state?.cwd === cwd ? state.status.pr : undefined
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

  // Checks finishing: tell the user, and fix a failure when asked to.
  useEffect(() => {
    if (!pr) {
      return
    }
    const previous = lastSeen.current
    lastSeen.current = { sha: pr.headSha, summary }
    const finished =
      previous?.sha === pr.headSha && previous.summary === 'pending' && summary !== 'pending'
    if (finished) {
      notify(
        chatId,
        `Pull request #${pr.number}`,
        summary === 'failing' ? 'Checks failed' : 'Checks passed'
      )
    }
    const key = `${chatId}:${pr.headSha}`
    if (summary === 'failing' && autoFixChats.has(chatId) && !autoFixed.has(key)) {
      const chat = useChatStore.getState().chats[chatId]
      if (chat && chat.status === 'idle' && !chat.bashRunning) {
        autoFixed.add(key)
        void buildFixPrompt(cwd, pr).then((prompt) =>
          useChatStore.getState().send(chatId, prompt, undefined, 'prompt').catch(() => {})
        )
      }
    }
  }, [pr, summary, chatId, cwd, autoFix])

  useEffect(() => {
    if (!open) {
      return
    }
    const close = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!pr || pr.state === 'CLOSED') {
    return null
  }

  const failing = pr.checks.filter((c) => c.state === 'fail').length
  const label =
    pr.state === 'MERGED'
      ? 'merged'
      : summary === 'failing'
        ? `${failing} failing`
        : summary === 'pending'
          ? 'running'
          : summary === 'passing'
            ? 'passing'
            : pr.draft
              ? 'draft'
              : ''

  const askFix = async (): Promise<void> => {
    setBusy(true)
    const prompt = await buildFixPrompt(cwd, pr)
    setBusy(false)
    setOpen(false)
    useChatStore.getState().seedComposer(chatId, prompt)
  }

  return (
    <div className="pr-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className={clsx('repo-chip', 'pr-chip', `pr-${pr.state === 'MERGED' ? 'merged' : summary}`)}
        data-testid="pr-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Pull request #${pr.number}: ${pr.title}`}
        onClick={() => setOpen(!open)}
      >
        <GitPullRequest size={11} />
        <span>#{pr.number}</span>
        {pr.state === 'OPEN' && summary === 'pending' && <LiveDot className="live-dot" />}
        {label && <span className="pr-chip-label">{label}</span>}
      </button>
      {open && (
        <div className="pr-popover" role="dialog" aria-label="Pull request" data-testid="pr-popover">
          <div className="pr-popover-title">{pr.title}</div>
          <div className="pr-popover-meta">
            #{pr.number}
            {pr.draft ? ' · draft' : ''}
            {pr.reviewDecision === 'APPROVED'
              ? ' · approved'
              : pr.reviewDecision === 'CHANGES_REQUESTED'
                ? ' · changes requested'
                : pr.reviewDecision === 'REVIEW_REQUIRED'
                  ? ' · review required'
                  : ''}
          </div>
          {pr.checks.length > 0 && (
            <div className="pr-checks">
              {pr.checks.map((check, i) => (
                <button
                  key={i}
                  type="button"
                  className="pr-check"
                  disabled={!check.url}
                  title={check.url ? 'Open the check' : undefined}
                  onClick={() => {
                    if (check.url) {
                      setOpen(false)
                      openInBrowser(check.url)
                    }
                  }}
                >
                  <span className={`pr-check-mark pr-check-${check.state}`} aria-hidden="true">
                    {check.state === 'pass' ? (
                      <Check size={11} />
                    ) : check.state === 'fail' ? (
                      <X size={11} />
                    ) : check.state === 'skipped' ? (
                      <Minus size={11} />
                    ) : (
                      <LiveDot className="live-dot" />
                    )}
                  </span>
                  <span className="pr-check-name">{check.name}</span>
                  <span className="pr-check-state">
                    {check.state === 'pass'
                      ? 'passed'
                      : check.state === 'fail'
                        ? 'failed'
                        : check.state === 'skipped'
                          ? 'skipped'
                          : 'running'}
                  </span>
                </button>
              ))}
            </div>
          )}
          {pr.checks.length === 0 && <div className="pr-popover-meta">No checks on this pull request.</div>}
          {pr.state === 'OPEN' && (
            <label className="pr-autofix">
              <input
                type="checkbox"
                checked={autoFix}
                onChange={(e) => {
                  if (e.target.checked) {
                    autoFixChats.add(chatId)
                  } else {
                    autoFixChats.delete(chatId)
                  }
                  setAutoFix(e.target.checked)
                  if (e.target.checked) {
                    toast('pi fixes failing checks while this chat is on screen')
                  }
                }}
              />
              <span>Fix failing checks automatically</span>
            </label>
          )}
          <div className="pr-popover-actions">
            {summary === 'failing' && pr.state === 'OPEN' && (
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                disabled={busy}
                data-testid="pr-fix"
                onClick={() => void askFix()}
              >
                <Wrench size={12} /> {busy ? 'Reading the log…' : 'Ask pi to fix'}
              </button>
            )}
            {pr.url && (
              <button
                type="button"
                className="ui-btn"
                onClick={() => {
                  setOpen(false)
                  void window.piDesktop.app.openExternal(pr.url).catch(() => {})
                }}
              >
                <ExternalLink size={12} /> Open on GitHub
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
