import {
  Check,
  ChevronDown,
  ChevronRight,
  FilePen,
  FileText,
  Globe,
  Loader2,
  MousePointerClick,
  Search,
  ShieldCheck,
  Terminal,
  Wrench,
  X
} from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import clsx from 'clsx'

import type { ToolRun } from '../../../shared/chat-view'
import { computerToolSummary } from '../lib/tool-summary'

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

function toolIcon(name: string) {
  const n = name.toLowerCase()
  if (n === 'computer_confirm') {
    return <ShieldCheck size={13} />
  }
  if (n.startsWith('computer_')) {
    return <MousePointerClick size={13} />
  }
  switch (toolKind(name)) {
    case 'bash':
      return <Terminal size={13} />
    case 'browser':
      return <Globe size={13} />
    case 'read':
      return <FileText size={13} />
    case 'edit':
    case 'write':
      return <FilePen size={13} />
    default:
      return name.toLowerCase().includes('grep') ||
        name.toLowerCase().includes('find') ||
        name.toLowerCase().includes('search') ? (
        <Search size={13} />
      ) : (
        <Wrench size={13} />
      )
  }
}

function relativePath(p: string, cwd: string): string {
  if (cwd && p.startsWith(cwd)) {
    const rest = p.slice(cwd.length).replace(/^[/\\]/, '')
    return rest || p
  }
  return p
}

function argPath(args: Record<string, unknown>): string | undefined {
  const p = args['path'] ?? args['file'] ?? args['filePath'] ?? args['file_path']
  return typeof p === 'string' ? p : undefined
}

function summarize(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  details?: Record<string, unknown>
): string {
  if (name.startsWith('computer_')) {
    return computerToolSummary(name, args, details)
  }
  if (toolKind(name) === 'bash') {
    return typeof args['command'] === 'string' ? (args['command'] as string) : ''
  }
  const p = argPath(args)
  if (p) {
    return relativePath(p, cwd)
  }
  const firstString = Object.values(args).find((v) => typeof v === 'string')
  return typeof firstString === 'string' ? firstString.slice(0, 120) : ''
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

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  return (
    <div className="tool-diff">
      <pre className="diff-old">
        {oldText.split('\n').map((line, i) => (
          <div key={i}>- {line}</div>
        ))}
      </pre>
      <pre className="diff-new">
        {newText.split('\n').map((line, i) => (
          <div key={i}>+ {line}</div>
        ))}
      </pre>
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
  return content.filter(
    (b): b is ImageBlock => b?.type === 'image' && typeof b.data === 'string'
  )
}

function ToolDetail({ run, cwd }: { run: ToolRun; cwd: string }) {
  const [showAll, setShowAll] = useState(false)
  const [showArgs, setShowArgs] = useState(false)
  const [showTree, setShowTree] = useState(false)
  const [expandedImage, setExpandedImage] = useState<number | null>(null)
  const kind = toolKind(run.name)

  const output = useMemo(() => resultText(run), [run])
  const images = useMemo(() => resultImages(run), [run])
  const truncated = !showAll && output.length > OUTPUT_LIMIT
  const shownOutput = truncated ? `${output.slice(0, OUTPUT_LIMIT)}\n…` : output
  const isError = run.status === 'error'
  const path = argPath(run.args)
  const edits = editEntries(run.args)
  const detailsDiff =
    run.result?.details &&
    typeof run.result.details === 'object' &&
    typeof (run.result.details as { diff?: unknown }).diff === 'string'
      ? ((run.result.details as { diff: string }).diff as string)
      : null
  const writeContent = typeof run.args['content'] === 'string' ? run.args['content'] : null
  const command = typeof run.args['command'] === 'string' ? run.args['command'] : null

  return (
    <div className="tool-detail">
      {kind === 'bash' && command !== null && (
        <div className="tool-command">
          <span className="tool-command-prompt">$</span> {command}
        </div>
      )}

      {(kind === 'read' || kind === 'write' || kind === 'edit') && path && (
        <div className="tool-path">{relativePath(path, cwd)}</div>
      )}

      {kind === 'edit' &&
        edits.map((entry, i) => (
          <DiffView
            key={i}
            oldText={entry.oldText ?? ''}
            newText={entry.newText ?? ''}
          />
        ))}
      {kind === 'edit' && edits.length === 0 && detailsDiff && (
        <pre className="tool-output">{detailsDiff}</pre>
      )}

      {kind === 'write' && writeContent !== null && (
        <pre className="tool-output">{firstLines(writeContent, PREVIEW_LINES).text}</pre>
      )}

      {kind === 'read' && output && (
        <pre className={clsx('tool-output', { 'is-error': isError })}>
          {firstLines(shownOutput, PREVIEW_LINES).text}
        </pre>
      )}
      {kind !== 'read' &&
        output &&
        (run.name === 'computer_state' ? (
          // The accessibility tree is bulky; keep it behind a second fold.
          <div>
            <button
              type="button"
              className="tool-show-all"
              onClick={() => setShowTree(!showTree)}
            >
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
          className={clsx('tool-image', { 'is-expanded': expandedImage === i })}
          title={expandedImage === i ? 'Shrink' : 'Expand'}
          onClick={() => setExpandedImage(expandedImage === i ? null : i)}
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
          <button
            type="button"
            className="tool-show-all"
            onClick={() => setShowArgs(!showArgs)}
          >
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
  className
}: {
  run: ToolRun
  cwd: string
  className?: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className={clsx('tool-card', `tool-${run.status}`, className)}>
      <button type="button" className="tool-row" onClick={() => setOpen(!open)}>
        <span className="tool-chevron">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="tool-icon">{toolIcon(run.name)}</span>
        <span className="tool-name">{run.name}</span>
        <span className="tool-summary">
          {summarize(
            run.name,
            run.args,
            cwd,
            run.result?.details as Record<string, unknown> | undefined
          )}
        </span>
        <span className="tool-status">
          {run.status === 'running' && <Loader2 size={13} className="spin" />}
          {run.status === 'done' && <Check size={13} />}
          {run.status === 'error' && <X size={13} />}
        </span>
      </button>

      {open && <ToolDetail run={run} cwd={cwd} />}
    </div>
  )
})
