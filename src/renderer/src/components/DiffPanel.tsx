import { ChevronDown, ChevronRight, FileDiff, RefreshCw } from 'lucide-react'
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
import { useChatStore, type ChatState } from '../state/chat-store'

const COLLAPSE_LINES = 400
const REFRESH_DEBOUNCE_MS = 500
const WRITE_TOOLS = /edit|write|bash|apply/i

/** Renders one file's hunks with line numbers; files stay collapsed >400 lines. */
const DiffFileView = memo(function DiffFileView({
  file,
  expanded,
  onToggle
}: {
  file: DiffFile
  expanded: boolean
  onToggle(): void
}) {
  const { added, deleted } = countChanges(file)
  const collapsible = added + deleted > COLLAPSE_LINES

  return (
    <div className="diff-file">
      <button type="button" className="diff-file-header" onClick={onToggle}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="diff-file-path" title={file.oldPath ?? file.path}>
          {file.status === 'renamed' && file.oldPath
            ? `${file.oldPath} → ${file.path}`
            : file.path}
        </span>
        <span className="diff-counts">
          {added > 0 && <span className="diff-add-count">+{added}</span>}
          {deleted > 0 && <span className="diff-del-count">−{deleted}</span>}
          <span className="diff-status-label">{file.status}</span>
        </span>
      </button>
      {expanded &&
        (file.isBinary ? (
          <div className="diff-binary">Binary file</div>
        ) : (
          <pre className="diff-hunks">
            {file.hunks.map((hunk, i) => (
              <span key={i}>
                <span className="diff-hunk-header">{hunk.header}</span>
                {hunk.lines.map((line, j) => (
                  <span key={j} className={`diff-line diff-${line.type}`}>
                    <span className="diff-lineno">{line.oldNo ?? ''}</span>
                    <span className="diff-lineno">{line.newNo ?? ''}</span>
                    <span className="diff-line-text">
                      {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                      {line.text}
                    </span>
                  </span>
                ))}
              </span>
            ))}
          </pre>
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
function ToolResultFallback({ chat }: { chat: ChatState | undefined }) {
  const runs = useMemo(
    () =>
      Object.values(chat?.toolRuns ?? {}).filter((run) =>
        WRITE_TOOLS.test(run.name)
      ),
    [chat?.toolRuns]
  )
  if (!chat) {
    return <div className="panel-empty">Not a git repository — open a chat to see changes.</div>
  }
  if (runs.length === 0) {
    return <div className="panel-empty">Not a git repository, and no file edits in this chat.</div>
  }
  return (
    <div className="diff-fallback">
      <div className="diff-fallback-hint">Not a git repository — showing this chat's edits.</div>
      {runs.map((run) => (
        <ToolRunDiff key={run.toolCallId} run={run} cwd={chat.cwd} />
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
  const chat = useChatStore((s) => (view.kind === 'chat' ? s.chats[view.chatId] : undefined))
  const chatId = view.kind === 'chat' ? view.chatId : null
  const cwd = chat?.cwd || workspaceDir

  const [result, setResult] = useState<RepoDiffResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Explicit expand/collapse overrides; untouched files follow the size rule.
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    return window.piDesktop.chat.onEvent(({ chatId: cid, event }) => {
      if (cid !== chatId) {
        return
      }
      if (event.type === 'agent_end') {
        debouncedRefresh()
      } else if (event.type === 'tool_execution_end' && WRITE_TOOLS.test(event.toolName)) {
        debouncedRefresh()
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
        <button
          type="button"
          className="icon-btn"
          title="Refresh diff"
          onClick={() => void refresh()}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="diff-body">
        {error && <div className="cmd-modal-error">{error}</div>}
        {result && !result.isRepo && <ToolResultFallback chat={chat} />}
        {result?.isRepo && files.length === 0 && (
          <div className="panel-empty">Working tree clean.</div>
        )}
        {files.map((file) => (
          <DiffFileView
            key={file.path}
            file={file}
            expanded={isExpanded(file)}
            onToggle={() =>
              setToggled((prev) => new Map(prev).set(file.path, !isExpanded(file)))
            }
          />
        ))}
      </div>
    </div>
  )
}
