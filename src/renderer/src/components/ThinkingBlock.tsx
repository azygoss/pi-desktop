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
    <div className="thinking-block">
      <button
        type="button"
        className="thinking-row"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{label}</span>
        {streaming && startedAt !== undefined && (
          <>
            <span aria-hidden="true">·</span>
            <Elapsed since={startedAt} />
          </>
        )}
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
})
