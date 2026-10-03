import { Check, ExternalLink, Minus, RefreshCw, Wrench, X } from 'lucide-react'
import { useState } from 'react'
import clsx from 'clsx'

import type { PrCheck } from '../../../shared/pr-status'
import { buildFixPrompt, usePrMonitorStore, usePrStatus } from '../lib/pr-monitor'
import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { openInBrowser } from '../state/panel-store'
import { LiveDot } from './LiveIndicators'

const STATE_LABEL: Record<PrCheck['state'], string> = {
  pass: 'passed',
  fail: 'failed',
  pending: 'running',
  skipped: 'skipped'
}

function CheckMark({ state }: { state: PrCheck['state'] }) {
  return (
    <span className={`pr-check-mark pr-check-${state}`} aria-hidden="true">
      {state === 'pass' ? (
        <Check size={12} />
      ) : state === 'fail' ? (
        <X size={12} />
      ) : state === 'skipped' ? (
        <Minus size={12} />
      ) : (
        <LiveDot className="live-dot" />
      )}
    </span>
  )
}

/** One check; a failed GitHub Actions job can unfold the end of its log. */
function CheckRow({ check, cwd }: { check: PrCheck; cwd: string }) {
  const [log, setLog] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const canShowLog = check.state === 'fail' && check.runId !== undefined

  const toggleLog = (): void => {
    if (log !== null) {
      setLog(null)
      return
    }
    setLoading(true)
    void window.piDesktop.pr
      .failedLog({ cwd, runId: check.runId! })
      .then((text) => setLog(text || 'No log available for this job.'))
      .catch(() => setLog('The log could not be read.'))
      .finally(() => setLoading(false))
  }

  return (
    <div className="pr-panel-check">
      <div className="pr-panel-check-row">
        <CheckMark state={check.state} />
        <span className="pr-check-name" title={check.name}>
          {check.name}
        </span>
        <span className="pr-check-state">{STATE_LABEL[check.state]}</span>
        {canShowLog && (
          <button type="button" className="diff-action" disabled={loading} onClick={toggleLog}>
            {loading ? 'Reading…' : log !== null ? 'Hide log' : 'Log'}
          </button>
        )}
        {check.url && (
          <button
            type="button"
            className="icon-btn"
            title="Open the check"
            onClick={() => openInBrowser(check.url!)}
          >
            <ExternalLink size={12} />
          </button>
        )}
      </div>
      {log !== null && <pre className="tool-output pr-panel-log">{log}</pre>}
    </div>
  )
}

/**
 * Pull request tab of the side panel: the same pull request the header chip
 * shows, with room for every check, failed logs and the fix actions. Follows
 * the chat on screen, like the diff tab.
 */
export function PrPanel({ active }: { active: boolean }) {
  const view = useAppStore((s) => s.view)
  const chatId = view.kind === 'chat' ? view.chatId : null
  const cwd = useChatStore((s) => (chatId ? s.chats[chatId]?.cwd : undefined)) ?? null
  const settled = useChatStore((s) =>
    chatId ? `${s.chats[chatId]?.status === 'streaming'}:${s.chats[chatId]?.bashRunning === true}` : ''
  )
  const autoFix = usePrMonitorStore((s) => (chatId ? s.autoFix[chatId] === true : false))
  const { status, pr, summary, reload } = usePrStatus(active ? cwd : null, settled)
  const [busy, setBusy] = useState(false)

  if (!active) {
    return <div className="pr-panel" />
  }

  const askFix = async (): Promise<void> => {
    if (!pr || !cwd || !chatId) {
      return
    }
    setBusy(true)
    const prompt = await buildFixPrompt(cwd, pr)
    setBusy(false)
    useChatStore.getState().seedComposer(chatId, prompt)
  }

  const failing = pr?.checks.filter((c) => c.state === 'fail').length ?? 0
  const headline = !pr
    ? 'Pull request'
    : `#${pr.number} · ${
        pr.state === 'MERGED'
          ? 'merged'
          : pr.state === 'CLOSED'
            ? 'closed'
            : summary === 'failing'
              ? `${failing} failing`
              : summary === 'pending'
                ? 'checks running'
                : summary === 'passing'
                  ? 'checks passing'
                  : 'no checks'
      }`

  return (
    <div className="pr-panel" data-testid="pr-panel">
      <div className="diff-toolbar">
        <span className={clsx('diff-summary', pr && `pr-headline-${summary}`)}>{headline}</span>
        <button type="button" className="icon-btn" title="Refresh" onClick={reload}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="pr-panel-body">
        {!cwd && <div className="panel-empty">Open a chat in a git project to see its pull request.</div>}
        {cwd && status === null && <div className="panel-empty">Reading the pull request…</div>}
        {status && !status.available && (
          <div className="panel-empty">
            Pull requests are read with the GitHub CLI. Install <code>gh</code> and run{' '}
            <code>gh auth login</code>, then refresh.
          </div>
        )}
        {status?.available && !pr && (
          <div className="panel-empty">No pull request for this project's current branch.</div>
        )}
        {pr && cwd && (
          <>
            <div className="pr-panel-title">{pr.title}</div>
            <div className="pr-popover-meta">
              {pr.draft ? 'draft · ' : ''}
              {pr.reviewDecision === 'APPROVED'
                ? 'approved'
                : pr.reviewDecision === 'CHANGES_REQUESTED'
                  ? 'changes requested'
                  : pr.reviewDecision === 'REVIEW_REQUIRED'
                    ? 'review required'
                    : 'no review yet'}
              {pr.headSha ? ` · ${pr.headSha.slice(0, 7)}` : ''}
            </div>
            <div className="pr-popover-actions">
              {summary === 'failing' && pr.state === 'OPEN' && chatId && (
                <button
                  type="button"
                  className="ui-btn ui-btn-primary"
                  disabled={busy}
                  data-testid="pr-panel-fix"
                  onClick={() => void askFix()}
                >
                  <Wrench size={12} /> {busy ? 'Reading the log…' : 'Ask pi to fix'}
                </button>
              )}
              {pr.url && (
                <button
                  type="button"
                  className="ui-btn"
                  onClick={() => void window.piDesktop.app.openExternal(pr.url).catch(() => {})}
                >
                  <ExternalLink size={12} /> Open on GitHub
                </button>
              )}
            </div>
            <div className="section-label pr-panel-section">
              Checks{pr.checks.length > 0 ? ` · ${pr.checks.length}` : ''}
            </div>
            {pr.checks.length === 0 && (
              <div className="pr-popover-meta">No checks on this pull request.</div>
            )}
            {pr.checks.map((check, i) => (
              <CheckRow key={`${check.name}:${i}`} check={check} cwd={cwd} />
            ))}
            {pr.state === 'OPEN' && chatId && (
              <label className="pr-autofix pr-panel-autofix">
                <input
                  type="checkbox"
                  checked={autoFix}
                  onChange={(e) => usePrMonitorStore.getState().setAutoFix(chatId, e.target.checked)}
                />
                <span>
                  Fix failing checks automatically
                  <span className="pr-panel-hint"> — once per commit, while this chat is on screen</span>
                </span>
              </label>
            )}
          </>
        )}
      </div>
    </div>
  )
}
