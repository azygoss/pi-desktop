import { ChevronDown, ChevronRight } from 'lucide-react'
import { memo, useState } from 'react'
import clsx from 'clsx'

export const ThinkingBlock = memo(function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking-block">
      <button
        type="button"
        className={clsx('thinking-row', { 'is-streaming': streaming })}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>Thinking</span>
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
})
