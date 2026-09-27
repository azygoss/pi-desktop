import { ChevronDown, ChevronRight } from 'lucide-react'
import { memo, useState } from 'react'
import clsx from 'clsx'

export const ThinkingBlock = memo(function ThinkingBlock({
  text,
  streaming,
  durationMs
}: {
  text: string
  streaming?: boolean
  /** Wall-clock duration measured on live streams (thinking_start → end). */
  durationMs?: number
}) {
  const [open, setOpen] = useState(false)
  const label = streaming
    ? 'Thinking…'
    : durationMs !== undefined
      ? `Thought for ${Math.max(1, Math.round(durationMs / 1000))}s`
      : 'Thinking'
  return (
    <div className="thinking-block">
      <button
        type="button"
        className={clsx('thinking-row', { 'is-streaming': streaming })}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{label}</span>
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
})
