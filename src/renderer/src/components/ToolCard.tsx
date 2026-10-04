import {
  Check,
  ChevronRight,
  Copy,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  MousePointerClick,
  Search,
  ShieldCheck,
  SquareTerminal,
  Wrench
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'

import type { ToolRun } from '../../../shared/chat-view'
import { diffLines, trimContext } from '../lib/line-diff'
import { isAbsolute, joinPath } from '../lib/paths'
import { summarizeToolRuns, toolCallSummary } from '../lib/tool-summary'
import { toolShots, type ToolShot } from '../lib/tool-images'
import {
  MIN_SHOWN_DURATION_MS,
  formatDuration,
  shellStatusLabel,
  splitShellStatus
} from '../lib/trace'
import { Elapsed } from './LiveIndicators'
import { zoomImage } from './Lightbox'
import { usePanelStore } from '../state/panel-store'

const OUTPUT_LIMIT = 4000
const PREVIEW_LINES = 40

type ToolKind = 'bash' | 'read' | 'edit' | 'write' | 'browser' | 'other'

function toolKind(name: string): ToolKind {
  const n = name.toLowerCase()
  if (n.startsWith('browser_')) {
    return 'browser'
  }
  if (n.includes('bash') || n.includes('shell') || n.includes('terminal')) {
    return 'bash'
  }
  if (n === 'read' || n.endsWith('_read') || n.includes('read')) {
    return 'read'
  }
  if (n === 'edit' || n.includes('edit')) {
    return 'edit'
  }
  if (n === 'write' || n.includes('write')) {
    return 'write'
  }
  return 'other'
}

/** Kind glyph for a step's icon tile. */
function toolIcon(name: string): ReactNode {
  const n = name.toLowerCase()
  if (n === 'computer_confirm') {
    return <ShieldCheck size={12} />
  }
  if (n.startsWith('computer_')) {
    return <MousePointerClick size={12} />
  }
  switch (toolKind(name)) {
    case 'bash':
      return <SquareTerminal size={12} />
    case 'browser':
      return <Globe size={12} />
    case 'read':
      return <FileText size={12} />
    case 'edit':
      return <FilePen size={12} />
    case 'write':
      return <FilePlus size={12} />
    default:
      return /grep|find|search|glob|ls\b/.test(n) ? <Search size={12} /> : <Wrench size={12} />
  }
}

function argPath(args: Record<string, unknown>): string | undefined {
  const p = args['path'] ?? args['file'] ?? args['filePath'] ?? args['file_path']
  return typeof p === 'string' ? p : undefined
}

function firstLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) {
    return { text, truncated: false }
  }
  return { text: lines.slice(0, maxLines).join('\n'), truncated: true }
}

function resultText(run: ToolRun): string {
  if (run.partialText) {
    return run.partialText
  }
  const content = run.result?.content
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text')
    .map((b) => b.text)
    .join('')
}

interface EditEntry {
  oldText?: string
  newText?: string
}

function editEntries(args: Record<string, unknown>): EditEntry[] {
  if (Array.isArray(args['edits'])) {
    return args['edits'] as EditEntry[]
  }
  if (typeof args['oldText'] === 'string' || typeof args['newText'] === 'string') {
    return [args as EditEntry]
  }
  return []
}

/** One edit as a unified diff: changes interleaved with a little context. */
function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = useMemo(() => trimContext(diffLines(oldText, newText)), [oldText, newText])
  return (
    <div className="tool-diff" role="group" aria-label="Change">
      {lines.map((line, i) =>
        line === null ? (
          <div key={i} className="diff-line diff-gap" aria-hidden="true">
            ⋯
          </div>
        ) : (
          <div key={i} className={`diff-line diff-${line.kind}`}>
            <span className="diff-sign" aria-hidden="true">
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}
            </span>
            <span className="diff-text">{line.text || ' '}</span>
          </div>
        )
      )}
    </div>
  )
}

interface ImageBlock {
  type: 'image'
  data: string
  mimeType: string
}

function resultImages(run: ToolRun): ImageBlock[] {
  const content = run.result?.content
  if (!Array.isArray(content)) {
    return []
  }
  return content.filter((b): b is ImageBlock => b?.type === 'image' && typeof b.data === 'string')
}

/** Duration label for a finished step, or null when too short to matter. */
function durationLabel(run: ToolRun): string | null {
  return run.durationMs !== undefined && run.durationMs >= MIN_SHOWN_DURATION_MS
    ? formatDuration(run.durationMs)
    : null
}

/** Commands the row can't show in full get their own line in the card. */
const LONG_COMMAND = 90

function commandOf(run: ToolRun): string | null {
  return typeof run.args['command'] === 'string' ? run.args['command'] : null
}

/** Copy the command line; flips to a check for a moment. */
function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
    },
    []
  )
  return (
    <button
      type="button"
      className="icon-btn term-copy"
      title={copied ? 'Copied' : 'Copy command'}
      aria-label="Copy command"
      onClick={() => {
        void navigator.clipboard.writeText(command)
        setCopied(true)
        if (timer.current) {
          clearTimeout(timer.current)
        }
        timer.current = setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

/**
 * A shell step expanded: one terminal surface — the prompt line, the
 * output, and pi's exit status as a footer instead of a line of output.
 */
function ShellDetail({ run, command }: { run: ToolRun; command: string }) {
  const [showAll, setShowAll] = useState(false)
  const { output, status } = useMemo(() => splitShellStatus(resultText(run)), [run])
  const body = output.replace(/\n+$/, '')
  const truncated = !showAll && body.length > OUTPUT_LIMIT
  const shown = truncated ? `${body.slice(0, OUTPUT_LIMIT)}\n…` : body
  const running = run.status === 'running'
  const failed = run.status === 'error'
  // The row already shows a one-line command; repeat it only when it is
  // multi-line or too long to read there.
  const showCommand = command.includes('\n') || command.length > LONG_COMMAND
  const statusLabel = status
    ? shellStatusLabel(status)
    : failed
      ? 'failed'
      : running
        ? null
        : 'exit 0'
  return (
    <div className="tool-detail">
      <div className={clsx('term', { 'is-failed': failed })}>
        {showCommand && (
          <div className="term-line">
            <span className="term-prompt" aria-hidden="true">
              $
            </span>
            <span className="term-cmd">{command}</span>
          </div>
        )}
        {shown || running ? (
          <pre className="term-output">
            {shown}
            {running && <span className="term-cursor" aria-hidden="true" />}
          </pre>
        ) : (
          <div className="term-output term-empty">no output</div>
        )}
        <div className="term-foot">
          {statusLabel && (
            <span className={clsx('term-status', { 'is-ok': !failed })}>{statusLabel}</span>
          )}
          {running && <span>running…</span>}
          <CopyCommand command={command} />
        </div>
      </div>
      {truncated && (
        <button type="button" className="tool-show-all" onClick={() => setShowAll(true)}>
          Show all ({body.length.toLocaleString()} chars)
        </button>
      )}
    </div>
  )
}

function ToolDetail({ run, cwd }: { run: ToolRun; cwd: string }) {
  const command = commandOf(run)
  const kind = toolKind(run.name)
  if (kind === 'bash' && command !== null) {
    return <ShellDetail run={run} command={command} />
  }
  const path = kind === 'read' || kind === 'edit' || kind === 'write' ? argPath(run.args) : undefined
  return (
    <>
      <GenericDetail run={run} />
      {path && (
        <div className="tool-file-actions">
          {cwd && (
            <button
              type="button"
              className="tool-show-all"
              onClick={() => usePanelStore.getState().openFile(cwd, path)}
            >
              Open
            </button>
          )}
          <button
            type="button"
            className="tool-show-all"
            onClick={() => {
              const full = isAbsolute(path) ? path : cwd ? joinPath(cwd, path) : ''
              if (full) {
                void window.piDesktop.app.revealPath(full).catch(() => {})
              }
            }}
          >
            Reveal in Finder
          </button>
          <button
            type="button"
            className="tool-show-all"
            onClick={() => void navigator.clipboard.writeText(path)}
          >
            Copy path
          </button>
        </div>
      )}
    </>
  )
}

function GenericDetail({ run }: { run: ToolRun }) {
  const [showAll, setShowAll] = useState(false)
  const [showArgs, setShowArgs] = useState(false)
  const [showTree, setShowTree] = useState(false)
  const kind = toolKind(run.name)

  const output = useMemo(() => resultText(run), [run])
  const images = useMemo(() => resultImages(run), [run])
  const truncated = !showAll && output.length > OUTPUT_LIMIT
  const shownOutput = truncated ? `${output.slice(0, OUTPUT_LIMIT)}\n…` : output
  const isError = run.status === 'error'
  const edits = editEntries(run.args)
  const detailsDiff =
    run.result?.details &&
    typeof run.result.details === 'object' &&
    typeof (run.result.details as { diff?: unknown }).diff === 'string'
      ? ((run.result.details as { diff: string }).diff as string)
      : null
  const writeContent = typeof run.args['content'] === 'string' ? run.args['content'] : null
  // A successful edit or write already shows what changed; its "ok" result
  // line would only repeat that.
  const changeShown =
    !isError &&
    ((kind === 'edit' && (edits.length > 0 || detailsDiff !== null)) ||
      (kind === 'write' && writeContent !== null))

  return (
    <div className="tool-detail">

      {kind === 'edit' &&
        edits.map((entry, i) => (
          <DiffView key={i} oldText={entry.oldText ?? ''} newText={entry.newText ?? ''} />
        ))}
      {kind === 'edit' && edits.length === 0 && detailsDiff && (
        <pre className="tool-output">{detailsDiff}</pre>
      )}

      {kind === 'write' && writeContent !== null && (
        <DiffView oldText="" newText={firstLines(writeContent, PREVIEW_LINES).text} />
      )}
      {kind === 'write' &&
        writeContent !== null &&
        firstLines(writeContent, PREVIEW_LINES).truncated && (
          <div className="tool-more-note">
            first {PREVIEW_LINES} of {writeContent.split('\n').length} lines
          </div>
        )}

      {kind === 'read' && output && (
        <pre className={clsx('tool-output', { 'is-error': isError })}>
          {firstLines(shownOutput, PREVIEW_LINES).text}
        </pre>
      )}
      {kind !== 'read' &&
        output &&
        !changeShown &&
        (run.name === 'computer_state' ? (
          // The accessibility tree is bulky; keep it behind a second fold.
          <div>
            <button type="button" className="tool-show-all" onClick={() => setShowTree(!showTree)}>
              {showTree ? 'Hide accessibility tree' : 'Accessibility tree'}
            </button>
            {showTree && (
              <pre className={clsx('tool-output', { 'is-error': isError })}>{shownOutput}</pre>
            )}
          </div>
        ) : (
          <pre className={clsx('tool-output', { 'is-error': isError })}>{shownOutput}</pre>
        ))}

      {images.map((image, i) => (
        <button
          key={i}
          type="button"
          className="tool-image"
          title="View image"
          onClick={() => zoomImage(image.mimeType, image.data)}
        >
          <img src={`data:${image.mimeType};base64,${image.data}`} alt="Tool result" />
        </button>
      ))}

      {truncated && (
        <button type="button" className="tool-show-all" onClick={() => setShowAll(true)}>
          Show all ({output.length.toLocaleString()} chars)
        </button>
      )}

      {kind === 'other' && Object.keys(run.args).length > 0 && (
        <div>
          <button type="button" className="tool-show-all" onClick={() => setShowArgs(!showArgs)}>
            {showArgs ? 'Hide arguments' : 'Arguments'}
          </button>
          {showArgs && <pre className="tool-args">{JSON.stringify(run.args, null, 2)}</pre>}
        </div>
      )}
    </div>
  )
}

export const ToolCard = memo(function ToolCard({
  run,
  cwd,
  className,
  defaultOpen
}: {
  run: ToolRun
  cwd: string
  className?: string
  /** Start expanded (a `!command` the user just ran wants its output). */
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen === true)
  const kind = toolKind(run.name)
  const command = kind === 'bash' ? commandOf(run) : null
  const changes = kind === 'edit' || kind === 'write' ? kind : null
  const diff = useMemo(
    () =>
      changes
        ? summarizeToolRuns([{ name: run.name, args: run.args, status: run.status }]).diff
        : null,
    [changes, run.name, run.args, run.status]
  )
  // A failed shell step shows its exit code instead of a bare "failed".
  const shellStatus = useMemo(
    () =>
      command !== null && run.status === 'error'
        ? splitShellStatus(resultText(run)).status
        : undefined,
    [command, run]
  )

  return (
    <div
      className={clsx(
        'tool-card',
        `tool-${run.status}`,
        { 'is-open': open, 'tool-shell': command !== null, 'tool-change': changes !== null },
        className
      )}
    >
      <button
        type="button"
        className="tool-row"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <StepIcon status={run.status}>{toolIcon(run.name)}</StepIcon>
        {command !== null ? (
          <>
            <span className="tool-summary tool-shell-cmd" title={command}>
              {command.split('\n')[0]}
            </span>
          </>
        ) : (
          <>
            <span className="tool-name">{run.name}</span>
            <span className="tool-summary" title={argPath(run.args)}>
              {toolCallSummary(
                run.name,
                run.args,
                cwd,
                run.result?.details as Record<string, unknown> | undefined
              )}
            </span>
          </>
        )}
        {diff && <DiffStat added={diff.added} removed={diff.removed} />}
        <span className="tool-status">
          {run.status === 'running' && <Elapsed since={run.startedAt} />}
          {run.status === 'error' && (shellStatus ? shellStatusLabel(shellStatus) : 'failed')}
          {run.status === 'done' && durationLabel(run)}
        </span>
        <span className="tool-chevron" aria-hidden="true">
          <ChevronRight size={12} />
        </span>
      </button>

      {open ? <ToolDetail run={run} cwd={cwd} /> : <ToolShots shots={toolShots(run)} />}
    </div>
  )
})

/**
 * Images tools produced, shown under a folded card or group: what the agent
 * put in front of the user with show_image at full width with its caption,
 * screenshots as thumbnails. Click opens the lightbox.
 */
export const ToolShots = memo(function ToolShots({ shots }: { shots: ToolShot[] }) {
  if (shots.length === 0) {
    return null
  }
  const shown = shots.filter((shot) => shot.shown)
  const thumbs = shots.filter((shot) => !shot.shown)
  return (
    <div className="tool-shots">
      {shown.map((shot) => (
        <figure key={shot.key} className="tool-shown">
          <button
            type="button"
            className="tool-shown-image"
            title="View image"
            onClick={() => zoomImage(shot.mimeType, shot.data)}
          >
            <img src={`data:${shot.mimeType};base64,${shot.data}`} alt={shot.caption ?? 'Image from pi'} />
          </button>
          {shot.caption && <figcaption>{shot.caption}</figcaption>}
        </figure>
      ))}
      {thumbs.length > 0 && (
        <div className="tool-thumbs">
          {thumbs.map((shot) => (
            <button
              key={shot.key}
              type="button"
              className="tool-image"
              title={shot.caption ?? 'View screenshot'}
              onClick={() => zoomImage(shot.mimeType, shot.data)}
            >
              <img src={`data:${shot.mimeType};base64,${shot.data}`} alt={shot.caption ?? 'Screenshot'} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
})

/** "+5 −1" line stat for a step or group; zero sides are left out. */
export function DiffStat({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) {
    return null
  }
  return (
    <span className="tool-group-diff">
      {added > 0 && <span className="diff-add-count">+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className="diff-del-count">−{removed}</span>}
    </span>
  )
}

/**
 * The step's icon tile: its kind at a glance, its state in the tile's color
 * — blue outline while running (blinking on the shared 1Hz clock), coral
 * when it failed, quiet ink when done.
 */
export function StepIcon({ status, children }: { status: ToolRun['status']; children: ReactNode }) {
  return (
    <span className={`step-icon step-${status}`} aria-hidden="true">
      {children}
    </span>
  )
}
