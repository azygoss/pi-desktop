import { ChevronDown, ChevronRight } from 'lucide-react'
import { Suspense, lazy, memo, useState } from 'react'
import clsx from 'clsx'

import { thinkingExcerpt } from '../lib/trace'
import { Elapsed } from './LiveIndicators'

// Same lazy chunk the transcript uses; only loads once a block is opened.
const LazyMarkdown = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })))

export const ThinkingBlock = memo(function ThinkingBlock({
  text,
  streaming,
  startedAt,
  durationMs
}: {
  text: string
  streaming?: boolean
  /** Live streams: when thinking began, for the running timer. */
  startedAt?: number
  /** Wall-clock duration measured on live streams (thinking_start → end). */
  durationMs?: number
}) {
  const [open, setOpen] = useState(false)
  const live = streaming === true
  const label = live
    ? 'Thinking'
    : durationMs !== undefined
      ? `Thought for ${Math.max(1, Math.round(durationMs / 1000))}s`
      : 'Thought'
  // Collapsed, a two-line excerpt hangs under the label: the tail while
  // live, the opening (heading + first sentence) once done.
  const excerpt = open ? '' : thinkingExcerpt(text, live)
  return (
    <div className={clsx('thinking-block', { 'is-open': open, 'is-live': live })}>
      <button
        type="button"
        className="thinking-row"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="thinking-node" aria-hidden="true" />
        <span className="thinking-label">{label}</span>
        {live && startedAt !== undefined && <Elapsed since={startedAt} />}
        <span className="thinking-chevron" aria-hidden="true">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      {excerpt && (
        <div className="thinking-excerpt" aria-hidden="true" onClick={() => setOpen(true)}>
          {excerpt}
        </div>
      )}
      {open && (
        <div className="thinking-body">
          <Suspense fallback={<div className="markdown markdown-fallback">{text}</div>}>
            <LazyMarkdown text={text} />
          </Suspense>
        </div>
      )}
    </div>
  )
})
