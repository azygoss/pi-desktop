import { ChevronDown, ChevronRight } from 'lucide-react'
import { memo, useState } from 'react'

import { Elapsed } from './LiveIndicators'

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
  const label = streaming
    ? 'Thinking'
    : durationMs !== undefined
      ? `Thought for ${Math.max(1, Math.round(durationMs / 1000))}s`
      : 'Thinking'
  return (
    <div className={open ? 'thinking-block is-open' : 'thinking-block'}>
      <button
        type="button"
        className="thinking-row"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span
          className={streaming ? 'thinking-node is-live' : 'thinking-node'}
          aria-hidden="true"
        />
        <span>{label}</span>
        {streaming && startedAt !== undefined && <Elapsed since={startedAt} />}
        <span className="thinking-chevron" aria-hidden="true">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
})
