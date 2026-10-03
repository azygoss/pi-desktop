import {
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  FileDiff,
  FileText,
  GitCommitHorizontal,
  Plus,
  RefreshCw,
  ScanSearch,
  Send,
  Undo2,
  X
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { RepoDiffResult } from '../../../shared/api'
import {
  countChanges,
  diffFileForUntracked,
  parseUnifiedDiff,
  type DiffFile
} from '../../../shared/diff-parse'
import type { ToolRun } from '../../../shared/chat-view'
import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { usePanelStore } from '../state/panel-store'
import { toast } from '../state/toast-store'
import { anchorForLine, reviewPrompt, type ReviewComment } from '../lib/review-comments'
import { joinPath } from '../lib/paths'

const COLLAPSE_LINES = 400
const REFRESH_DEBOUNCE_MS = 500
const WRITE_TOOLS = /edit|write|bash|apply/i
const NO_COMMENTS = new Map<string, ReviewComment[]>()

/** Renders one file's hunks with line numbers; files stay collapsed >400 lines. */
const DiffFileView = memo(function DiffFileView({
  file,
  expanded,
  comments,
  onToggle,
  onOpen,
  onDiscard,
  onComment,
  onRemoveComment
}: {
  file: DiffFile
  expanded: boolean
  /** This file's review comments, keyed by `hunk:line`. */
  comments: Map<string, ReviewComment[]>
  onToggle(): void
  onOpen(): void
  onDiscard(): void
  onComment(key: string, line: number | undefined, lineText: string, text: string): void
  onRemoveComment(id: string): void
}) {
  const { added, deleted } = countChanges(file)
  const collapsible = added + deleted > COLLAPSE_LINES
  // The line being commented on (`hunk:line`) and its unsaved text.
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const save = (key: string, line: number | undefined, lineText: string): void => {
    if (draft.trim()) {
      onComment(key, line, lineText, draft.trim())
    }
    setEditing(null)
    setDraft('')
  }

  return (
    <div className="diff-file">
      <div
        className="diff-file-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target === e.currentTarget) {
            onToggle()
          }
        }}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="diff-file-path" title={file.oldPath ?? file.path}>
          {file.status === 'renamed' && file.oldPath
            ? `${file.oldPath} → ${file.path}`
            : file.path}
        </span>
        <span className="diff-file-actions">
          {file.status !== 'deleted' && (
            <button
              type="button"
              className="icon-btn"
              title="Open file"
              onClick={(e) => {
                e.stopPropagation()
                onOpen()
              }}
            >
              <FileText size={12} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title="Discard this file's changes…"
            onClick={(e) => {
              e.stopPropagation()
              onDiscard()
            }}
          >
            <Undo2 size={12} />
          </button>
        </span>
        <span className="diff-counts">
          {added > 0 && <span className="diff-add-count">+{added}</span>}
          {deleted > 0 && <span className="diff-del-count">−{deleted}</span>}
          <span className="diff-status-label">{file.status}</span>
        </span>
      </div>
      {expanded &&
        (file.isBinary ? (
          <div className="diff-binary">Binary file</div>
        ) : (
          <div className="diff-hunks">
            {file.hunks.map((hunk, i) => (
              <div key={i}>
                <div className="diff-hunk-header">{hunk.header}</div>
                {hunk.lines.map((line, j) => {
                  const key = `${i}:${j}`
                  const lineNo = line.newNo ?? line.oldNo
                  const notes = comments.get(key)
                  return (
                    <div key={j} className="diff-row">
                      <div className={`diff-line diff-${line.type}`}>
                        <button
                          type="button"
                          className="diff-comment-add"
                          title="Comment on this line"
                          aria-label="Comment on this line"
                          onClick={() => {
                            setEditing(key)
                            setDraft('')
                          }}
                        >
                          <Plus size={10} />
                        </button>
                        <span className="diff-lineno">{line.oldNo ?? ''}</span>
                        <span className="diff-lineno">{line.newNo ?? ''}</span>
                        <span className="diff-line-text">
                          {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                          {line.text}
                        </span>
                      </div>
                      {notes?.map((note) => (
                        <div
                          key={note.id}
                          className={
                            note.author === 'pi' ? 'diff-comment diff-comment-pi' : 'diff-comment'
                          }
                        >
                          <span className="diff-comment-text">
                            {note.author === 'pi' && <span className="diff-comment-by">pi</span>}
                            {note.text}
                          </span>
                          <button
                            type="button"
                            className="icon-btn"
                            title="Remove comment"
                            onClick={() => onRemoveComment(note.id)}
                          >
                            <X size={11} />
                          </button>
                        </div>
                      ))}
                      {editing === key && (
                        <div className="diff-comment diff-comment-editor">
                          <textarea
                            autoFocus
                            rows={2}
                            value={draft}
                            placeholder="Comment for pi — Enter to add, Esc to cancel"
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault()
                                save(key, lineNo, line.text)
                              } else if (e.key === 'Escape') {
                                e.stopPropagation()
                                setEditing(null)
                              }
                            }}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        ))}
      {collapsible && !expanded && (
        <button type="button" className="tool-show-all" onClick={onToggle}>
          Show {added + deleted} changed lines
        </button>
      )}
    </div>
  )
})

/** Fallback for non-git directories: the chat's own edit/write tool results. */
function ToolResultFallback({ chatId }: { chatId: string | null }) {
  // Subscribing to toolRuns only (not the whole chat) keeps this quiet while
  // text deltas stream — toolRuns object identity survives stream flushes.
  const toolRuns = useChatStore((s) => (chatId ? s.chats[chatId]?.toolRuns : undefined))
  const cwd = useChatStore((s) => (chatId ? s.chats[chatId]?.cwd : undefined))
  const runs = useMemo(
    () => Object.values(toolRuns ?? {}).filter((run) => WRITE_TOOLS.test(run.name)),
    [toolRuns]
  )
  if (!chatId || !cwd) {
    return <div className="panel-empty">Not a git repository — open a chat to see changes.</div>
  }
  if (runs.length === 0) {
    return <div className="panel-empty">Not a git repository, and no file edits in this chat.</div>
  }
  return (
    <div className="diff-fallback">
      <div className="diff-fallback-hint">Not a git repository — showing this chat's edits.</div>
      {runs.map((run) => (
        <ToolRunDiff key={run.toolCallId} run={run} cwd={cwd} />
      ))}
    </div>
  )
}

function argPath(args: Record<string, unknown>): string | undefined {
  const p = args['path'] ?? args['file'] ?? args['filePath'] ?? args['file_path']
  return typeof p === 'string' ? p : undefined
}

function editEntries(args: Record<string, unknown>): { oldText?: string; newText?: string }[] {
  if (Array.isArray(args['edits'])) {
    return args['edits'] as { oldText?: string; newText?: string }[]
  }
  if (typeof args['oldText'] === 'string' || typeof args['newText'] === 'string') {
    return [args as { oldText?: string; newText?: string }]
  }
  return []
}

function ToolRunDiff({ run, cwd }: { run: ToolRun; cwd: string }) {
  const path = argPath(run.args)
  const edits = editEntries(run.args)
  const detailsDiff =
    run.result?.details &&
    typeof run.result.details === 'object' &&
    typeof (run.result.details as { diff?: unknown }).diff === 'string'
      ? (run.result.details as { diff: string }).diff
      : null
  const writeContent =
    typeof run.args['content'] === 'string' ? run.args['content'] : null
  const rel = path && cwd && path.startsWith(cwd) ? path.slice(cwd.length + 1) : path

  return (
    <div className="diff-file">
      <div className="diff-file-header diff-file-header-static">
        <FileDiff size={12} />
        <span className="diff-file-path">{rel ?? run.name}</span>
        <span className="diff-status-label">{run.name}</span>
      </div>
      {edits.map((entry, i) => (
        <pre key={i} className="diff-hunks">
          {(entry.oldText ?? '').split('\n').map((text, j) => (
            <span key={`d${j}`} className="diff-line diff-del">
              <span className="diff-lineno" />
              <span className="diff-lineno" />
              <span className="diff-line-text">-{text}</span>
            </span>
          ))}
          {(entry.newText ?? '').split('\n').map((text, j) => (
            <span key={`a${j}`} className="diff-line diff-add">
              <span className="diff-lineno" />
              <span className="diff-lineno" />
              <span className="diff-line-text">+{text}</span>
            </span>
          ))}
        </pre>
      ))}
      {edits.length === 0 && detailsDiff && <pre className="tool-output">{detailsDiff}</pre>}
      {edits.length === 0 && !detailsDiff && writeContent && (
        <pre className="tool-output">{writeContent.split('\n').slice(0, 40).join('\n')}</pre>
      )}
    </div>
  )
}

/**
 * Working-tree diff for the active chat's cwd. Refreshes on file-changing
 * tool results and agent_end (debounced), on becoming the active tab and via
 * the refresh button. Does nothing while hidden.
 */
export function DiffPanel({ active }: { active: boolean }) {
  const view = useAppStore((s) => s.view)
  const workspaceDir = useAppStore((s) => s.appInfo?.workspaceDir ?? '')
  const chatId = view.kind === 'chat' ? view.chatId : null
  const chatCwd = useChatStore((s) => (chatId ? s.chats[chatId]?.cwd : undefined))
  const cwd = chatCwd || workspaceDir

  const [result, setResult] = useState<RepoDiffResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Explicit expand/collapse overrides; untouched files follow the size rule.
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Review comments on diff lines, sent to pi as one prompt.
  const [comments, setComments] = useState<(ReviewComment & { key: string })[]>([])
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [busy, setBusy] = useState<'commit' | 'push' | 'review' | null>(null)

  const refresh = useCallback(async () => {
    if (!cwd) {
      return
    }
    try {
      const next = await window.piDesktop.diff.status({ cwd })
      setResult(next)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [cwd])

  const debouncedRefresh = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    debounceRef.current = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS)
  }, [refresh])

  // Refresh when this tab becomes active and when cwd changes. Deferred so
  // the async IPC result doesn't set state synchronously inside the effect.
  useEffect(() => {
    if (!active) {
      return
    }
    const timer = setTimeout(() => void refresh(), 0)
    return () => clearTimeout(timer)
  }, [active, refresh])

  // Debounced refresh on file-changing tool results and agent_end.
  useEffect(() => {
    if (!active || !chatId) {
      return
    }
    return window.piDesktop.chat.onEvent(({ chatId: cid, events }) => {
      if (cid !== chatId) {
        return
      }
      for (const event of events) {
        if (event.type === 'agent_end') {
          debouncedRefresh()
        } else if (event.type === 'tool_execution_end' && WRITE_TOOLS.test(event.toolName)) {
          debouncedRefresh()
        }
      }
    })
  }, [active, chatId, debouncedRefresh])

  const files = useMemo(() => {
    if (!result?.isRepo) {
      return []
    }
    const parsed = parseUnifiedDiff(result.diffText)
    const known = new Set(parsed.map((f) => f.path))
    const extra = result.untracked
      .filter((u) => !known.has(u.path))
      .map((u) => diffFileForUntracked(u.path, u.content))
    return [...parsed, ...extra]
  }, [result])

  const totals = useMemo(() => {
    let added = 0
    let deleted = 0
    for (const f of files) {
      const c = countChanges(f)
      added += c.added
      deleted += c.deleted
    }
    return { added, deleted }
  }, [files])

  const isExpanded = (file: DiffFile): boolean => {
    const override = toggled.get(file.path)
    if (override !== undefined) {
      return override
    }
    const { added, deleted } = countChanges(file)
    return added + deleted <= COLLAPSE_LINES
  }

  const commentsByFile = useMemo(() => {
    const byFile = new Map<string, Map<string, ReviewComment[]>>()
    for (const comment of comments) {
      let lines = byFile.get(comment.path)
      if (!lines) {
        byFile.set(comment.path, (lines = new Map()))
      }
      lines.set(comment.key, [...(lines.get(comment.key) ?? []), comment])
    }
    return byFile
  }, [comments])

  // Ask pi for a review pass (in its own session-less process) and pin its
  // remarks to the diff lines they are about.
  const review = async (): Promise<void> => {
    if (busy) {
      return
    }
    setBusy('review')
    const chat = chatId ? useChatStore.getState().chats[chatId] : undefined
    const model = chat?.model
      ? { provider: chat.model.provider, modelId: chat.model.id }
      : undefined
    let remarks
    try {
      remarks = await window.piDesktop.diff.review({ cwd, ...(model ? { model } : {}) })
    } catch (e) {
      setBusy(null)
      toast(`Review failed: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    setBusy(null)
    if (remarks === null) {
      toast("pi's review could not be read")
      return
    }
    const placed: (ReviewComment & { key: string })[] = []
    for (const remark of remarks) {
      const file = files.find((f) => f.path === remark.path)
      const anchor = file ? anchorForLine(file, remark.line) : null
      if (!file || !anchor) {
        continue
      }
      placed.push({
        id: crypto.randomUUID(),
        key: anchor.key,
        path: file.path,
        line: anchor.exact ? anchor.line : remark.line,
        lineText: anchor.exact ? anchor.lineText : '',
        text:
          !anchor.exact && remark.line !== undefined
            ? `Line ${remark.line}: ${remark.comment}`
            : remark.comment,
        author: 'pi'
      })
    }
    // A new pass replaces pi's earlier remarks; yours stay.
    setComments((prev) => [...prev.filter((c) => c.author !== 'pi'), ...placed])
    setToggled((prev) => {
      const next = new Map(prev)
      for (const comment of placed) {
        next.set(comment.path, true)
      }
      return next
    })
    toast(
      placed.length === 0
        ? 'pi found nothing to flag'
        : `pi left ${placed.length} ${placed.length === 1 ? 'remark' : 'remarks'}`
    )
  }

  const sendComments = (): void => {
    if (!chatId || comments.length === 0) {
      return
    }
    useChatStore.getState().seedComposer(chatId, reviewPrompt(comments))
    setComments([])
  }

  const discard = async (file: DiffFile): Promise<void> => {
    const untracked = file.status === 'added'
    const choice = await window.piDesktop.app.confirmDialog({
      title: `Discard changes to ${file.path}?`,
      message: untracked
        ? 'The file is moved to the Trash.'
        : 'The file is restored to the last commit. This cannot be undone.',
      buttons: ['Discard', 'Cancel'],
      danger: true
    })
    if (choice !== 0) {
      return
    }
    const outcome = await window.piDesktop.diff
      .discard({ cwd, path: file.path })
      .catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }))
    if (!outcome.ok) {
      toast(`Discard failed: ${outcome.message}`)
    }
    setComments((prev) => prev.filter((c) => c.path !== file.path))
    void refresh()
  }

  const commit = async (): Promise<void> => {
    const message = commitMessage.trim()
    if (!message || busy) {
      return
    }
    setBusy('commit')
    const outcome = await window.piDesktop.diff
      .commit({ cwd, message })
      .catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }))
    setBusy(null)
    toast(outcome.ok ? outcome.message : `Commit failed: ${outcome.message}`)
    if (outcome.ok) {
      setCommitOpen(false)
      setCommitMessage('')
      setComments([])
      void refresh()
    }
  }

  const push = async (): Promise<void> => {
    if (busy) {
      return
    }
    setBusy('push')
    const outcome = await window.piDesktop.diff
      .push({ cwd })
      .catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }))
    setBusy(null)
    toast(outcome.ok ? outcome.message : `Push failed: ${outcome.message}`)
  }

  if (!active) {
    return <div className="diff-panel" />
  }

  return (
    <div className="diff-panel">
      <div className="diff-toolbar">
        <span className="diff-summary">
          {result?.isRepo
            ? `${files.length} file${files.length === 1 ? '' : 's'} changed · +${totals.added} −${totals.deleted}${result.branch ? ` · ${result.branch}` : ''}`
            : 'Diff'}
        </span>
        <span className="diff-toolbar-actions">
          {comments.length > 0 && chatId && (
            <button
              type="button"
              className="diff-action diff-action-primary"
              data-testid="send-comments"
              title="Put the comments in the composer"
              onClick={sendComments}
            >
              <Send size={11} />
              {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
            </button>
          )}
          {result?.isRepo && files.length > 0 && (
            <button
              type="button"
              className="diff-action"
              data-testid="review-diff"
              title="Have pi review these changes"
              disabled={busy !== null}
              onClick={() => void review()}
            >
              <ScanSearch size={12} />
              {busy === 'review' ? 'Reviewing…' : 'Review'}
            </button>
          )}
          {result?.isRepo && files.length > 0 && (
            <button
              type="button"
              className="diff-action"
              title="Commit all changes"
              onClick={() => setCommitOpen(!commitOpen)}
            >
              <GitCommitHorizontal size={12} />
              Commit
            </button>
          )}
          {result?.isRepo && (
            <button
              type="button"
              className="diff-action"
              title="Push the current branch"
              disabled={busy !== null}
              onClick={() => void push()}
            >
              <ArrowUpFromLine size={11} />
              {busy === 'push' ? 'Pushing…' : 'Push'}
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title="Refresh diff"
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} />
          </button>
        </span>
      </div>
      {commitOpen && (
        <div className="diff-commit">
          <input
            autoFocus
            value={commitMessage}
            placeholder="Commit message"
            spellCheck={false}
            onChange={(e) => setCommitMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void commit()
              } else if (e.key === 'Escape') {
                e.stopPropagation()
                setCommitOpen(false)
              }
            }}
          />
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            disabled={!commitMessage.trim() || busy !== null}
            onClick={() => void commit()}
          >
            {busy === 'commit' ? 'Committing…' : `Commit ${files.length} ${files.length === 1 ? 'file' : 'files'}`}
          </button>
        </div>
      )}
      <div className="diff-body">
        {error && <div className="cmd-modal-error">{error}</div>}
        {result && !result.isRepo && <ToolResultFallback chatId={chatId} />}
        {result?.isRepo && files.length === 0 && (
          <div className="panel-empty">Working tree clean.</div>
        )}
        {files.map((file) => (
          <DiffFileView
            key={file.path}
            file={file}
            expanded={isExpanded(file)}
            comments={commentsByFile.get(file.path) ?? NO_COMMENTS}
            onToggle={() =>
              setToggled((prev) => new Map(prev).set(file.path, !isExpanded(file)))
            }
            onOpen={() =>
              // Diff paths are relative to the repo root, which is where
              // `git diff` ran from when cwd is the root; resolve from cwd.
              usePanelStore.getState().openFile(cwd, joinPath(result?.root ?? cwd, file.path))
            }
            onDiscard={() => void discard(file)}
            onComment={(key, line, lineText, text) =>
              setComments((prev) => [
                ...prev,
                { id: crypto.randomUUID(), key, path: file.path, line, lineText, text }
              ])
            }
            onRemoveComment={(id) => setComments((prev) => prev.filter((c) => c.id !== id))}
          />
        ))}
      </div>
    </div>
  )
}
