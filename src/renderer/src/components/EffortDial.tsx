import { useRef, useState, type CSSProperties } from 'react'
import clsx from 'clsx'

import type { ThinkingLevel } from '../../../shared/pi-types'
import { thinkingLevelLabel } from '../../../shared/thinking'

/** What each level buys, in a few words. */
const LEVEL_HINTS: Record<ThinkingLevel, string> = {
  off: 'Answers right away, no thinking phase',
  minimal: 'A quick check before answering',
  low: 'Light reasoning, stays fast',
  medium: 'Balanced depth and speed',
  high: 'Thinks it through carefully',
  xhigh: 'Deep reasoning, noticeably slower',
  max: 'Everything it has, slowest'
}

/** Short tick labels that fit seven columns. */
const TICKS: Record<ThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHi',
  max: 'Max'
}

const MIN_BAR = 8
const MAX_BAR = 32

/**
 * Thinking effort as a signal meter: one rising bar per level the model
 * offers. Bars up to the chosen level light in deepening blue; hovering
 * previews another level (bars and hint follow the pointer) before a click
 * commits it. A radiogroup: ←/→, Home and End move the choice.
 */
export function EffortDial({
  levels,
  value,
  onChange
}: {
  levels: ThinkingLevel[]
  value: ThinkingLevel | null
  onChange(level: ThinkingLevel): void
}) {
  const [hover, setHover] = useState<ThinkingLevel | null>(null)
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const activeIdx = value ? levels.indexOf(value) : -1
  const shown = hover ?? value
  const shownIdx = shown ? levels.indexOf(shown) : -1
  const steps = Math.max(1, levels.length - 1)

  function choose(index: number): void {
    const level = levels[Math.max(0, Math.min(levels.length - 1, index))]
    if (level) {
      onChange(level)
      refs.current[levels.indexOf(level)]?.focus()
    }
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    const from = activeIdx < 0 ? 0 : activeIdx
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowUp'
        ? from + 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
          ? from - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? levels.length - 1
              : null
    if (next !== null) {
      e.preventDefault()
      choose(next)
    }
  }

  return (
    <div
      className={clsx('thinking-segment', 'effort', {
        'is-previewing': hover !== null && hover !== value
      })}
      onMouseLeave={() => setHover(null)}
    >
      <div className="effort-head">
        <span className="effort-title">Thinking effort</span>
        <span className="effort-value">{shown ? thinkingLevelLabel(shown) : '—'}</span>
      </div>
      <div
        className="effort-bars"
        role="radiogroup"
        aria-label="Thinking effort"
        style={{ gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` }}
        onKeyDown={onKeyDown}
      >
        {levels.map((level, i) => {
          const t = i / steps
          const style = {
            '--bar': `${Math.round(MIN_BAR + (MAX_BAR - MIN_BAR) * t)}px`,
            '--mix': `${Math.round(45 + 55 * t)}%`
          } as CSSProperties
          return (
            <button
              key={level}
              ref={(el) => {
                refs.current[i] = el
              }}
              type="button"
              role="radio"
              aria-checked={level === value}
              aria-label={`${thinkingLevelLabel(level)}: ${LEVEL_HINTS[level]}`}
              tabIndex={level === value || (activeIdx < 0 && i === 0) ? 0 : -1}
              className={clsx('effort-step', {
                'is-lit': level !== 'off' && i <= shownIdx,
                'is-active': level === value,
                'is-off': level === 'off'
              })}
              style={style}
              onMouseEnter={() => setHover(level)}
              onClick={() => choose(i)}
            >
              <span className="effort-bar" />
              <span className="effort-tick">{TICKS[level]}</span>
            </button>
          )
        })}
      </div>
      <div className="effort-hint">{shown ? LEVEL_HINTS[shown] : 'Pick how hard pi thinks'}</div>
    </div>
  )
}
