import {
  Check,
  ChevronDown,
  ChevronRight,
  FilePen,
  FileText,
  Loader2,
  Search,
  Terminal,
  Wrench,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import clsx from 'clsx'

import type { ToolRun } from '../../../shared/chat-view'

const OUTPUT_LIMIT = 4000

function toolIcon(name: string) {
  const n = name.toLowerCase()
  if (n.includes('bash') || n.includes('shell') || n.includes('terminal')) {
    return <Terminal size={13} />
  }
  if (n.includes('read')) {
    return <FileText size={13} />
  }
  if (n.includes('edit') || n.includes('write')) {
    return <FilePen size={13} />
  }
  if (n.includes('grep') || n.includes('find') || n.includes('search')) {
    return <Search size={13} />
  }
  return <Wrench size={13} />
}

function relativePath(p: string, cwd: string): string {
  if (cwd && p.startsWith(cwd)) {
    const rest = p.slice(cwd.length).replace(/^[/\\]/, '')
    return rest || p
  }
  return p
}

function summarize(name: string, args: Record<string, unknown>, cwd: string): string {
  const n = name.toLowerCase()
  const firstString = Object.values(args).find((v) => typeof v === 'string') as
    | string
    | undefined
  if (n.includes('bash') || n.includes('shell')) {
    return String(args.command ?? args.cmd ?? firstString ?? '')
  }
  if (n.includes('read') || n.includes('edit') || n.includes('write')) {
    const p = args.path ?? args.file ?? args.filePath ?? args.file_path
    if (typeof p === 'string') {
      return relativePath(p, cwd)
    }
  }
  return firstString ? firstString.slice(0, 120) : ''
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

export function ToolCard({ run, cwd }: { run: ToolRun; cwd: string }) {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const output = useMemo(() => resultText(run), [run])
  const truncated = !showAll && output.length > OUTPUT_LIMIT
  const shownOutput = truncated ? `${output.slice(0, OUTPUT_LIMIT)}\n…` : output
  const oldText = typeof run.args.oldText === 'string' ? run.args.oldText : undefined
  const newText = typeof run.args.newText === 'string' ? run.args.newText : undefined
  const hasDiff = oldText !== undefined || newText !== undefined

  return (
    <div className={clsx('tool-card', `tool-${run.status}`)}>
      <button type="button" className="tool-row" onClick={() => setOpen(!open)}>
        <span className="tool-chevron">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="tool-icon">{toolIcon(run.name)}</span>
        <span className="tool-name">{run.name}</span>
        <span className="tool-summary">{summarize(run.name, run.args, cwd)}</span>
        <span className="tool-status">
          {run.status === 'running' && <Loader2 size={13} className="spin" />}
          {run.status === 'done' && <Check size={13} />}
          {run.status === 'error' && <X size={13} />}
        </span>
      </button>

      {open && (
        <div className="tool-detail">
          {hasDiff && (
            <div className="tool-diff">
              {oldText !== undefined && (
                <pre className="diff-old">
                  {oldText.split('\n').map((line, i) => (
                    <div key={i}>- {line}</div>
                  ))}
                </pre>
              )}
              {newText !== undefined && (
                <pre className="diff-new">
                  {newText.split('\n').map((line, i) => (
                    <div key={i}>+ {line}</div>
                  ))}
                </pre>
              )}
            </div>
          )}
          {!hasDiff && Object.keys(run.args).length > 0 && (
            <pre className="tool-args">{JSON.stringify(run.args, null, 2)}</pre>
          )}
          {shownOutput && (
            <pre className="tool-output">{shownOutput}</pre>
          )}
          {truncated && (
            <button
              type="button"
              className="tool-show-all"
              onClick={() => setShowAll(true)}
            >
              Show all ({output.length.toLocaleString()} chars)
            </button>
          )}
        </div>
      )}
    </div>
  )
}
