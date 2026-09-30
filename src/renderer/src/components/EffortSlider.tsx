import { Zap } from 'lucide-react'
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

/** Short stop labels that fit seven stops on the track. */
const TICKS: Record<ThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHi',
  max: 'Max'
}

/**
 * Thinking effort as a slider: a track with one stop per level the model
 * offers. Drag the thumb (it follows the pointer, then settles on the
 * nearest stop), click the track or a label, or use ←/→/Home/End. At the
 * model's top level the track charges up: a hotter fill, a glow and a single
 * light sweep as it gets there (one-shot — see "Performance and energy" in
 * AGENTS.md).
 */
export function EffortSlider({
  levels,
  value,
  onChange
}: {
  levels: ThinkingLevel[]
  value: ThinkingLevel | null
  onChange(level: ThinkingLevel): void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  // Fraction 0..1 while dragging; null when at rest on the committed stop.
  const [drag, setDrag] = useState<number | null>(null)
  const last = Math.max(1, levels.length - 1)
  const valueIdx = value ? Math.max(0, levels.indexOf(value)) : 0

  const fraction = drag ?? valueIdx / last
  const shownIdx = Math.round(fraction * last)
  const shown = levels[shownIdx] ?? value
  const charged = levels.length > 1 && shownIdx === last && levels[last] !== 'off'

  function fractionAt(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) {
      return 0
    }
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }

  function commit(index: number): void {
    const level = levels[Math.max(0, Math.min(last, index))]
    if (level && level !== value) {
      onChange(level)
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) {
      return
    }
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    setDrag(fractionAt(e.clientX))
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (drag !== null) {
      setDrag(fractionAt(e.clientX))
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    if (drag === null) {
      return
    }
    commit(Math.round(fractionAt(e.clientX) * last))
    setDrag(null)
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowUp'
        ? valueIdx + 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
          ? valueIdx - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null
    if (next !== null) {
      e.preventDefault()
      commit(next)
    }
  }

  const style = { '--pos': `${fraction * 100}%`, '--t': fraction } as CSSProperties

  return (
    <div
      className={clsx('thinking-segment', 'effort', {
        'is-dragging': drag !== null,
        'is-charged': charged
      })}
      style={style}
    >
      <div className="effort-head">
        <span className="effort-title">Thinking effort</span>
        <span className="effort-value">
          {charged && <Zap size={12} className="effort-bolt" aria-hidden="true" />}
          {shown ? thinkingLevelLabel(shown) : '—'}
        </span>
      </div>
      <div
        ref={trackRef}
        className="effort-track"
        role="slider"
        tabIndex={0}
        aria-label="Thinking effort"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={valueIdx}
        aria-valuetext={value ? thinkingLevelLabel(value) : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={onKeyDown}
      >
        <div className="effort-rail">
          <div className="effort-fill" key={charged ? 'charged' : 'plain'} />
        </div>
        <span className="effort-thumb" />
      </div>
      <div className="effort-ticks">
        {levels.map((level, i) => (
          <button
            key={level}
            type="button"
            tabIndex={-1}
            className={clsx('effort-tick', {
              'is-lit': i <= shownIdx,
              'is-active': i === shownIdx,
              'is-first': i === 0,
              'is-last': i === last
            })}
            style={{ left: `${(i / last) * 100}%` }}
            onClick={() => commit(i)}
          >
            {TICKS[level]}
          </button>
        ))}
      </div>
      <div className="effort-hint">{shown ? LEVEL_HINTS[shown] : 'Pick how hard pi thinks'}</div>
    </div>
  )
}
