import { Check, ChevronDown, ScanSearch, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'

import type { Model } from '../../../shared/pi-types'
import type { SideModelInput } from '../../../shared/api'
import { usePopoverPlacement } from '../lib/popover-placement'
import { providerLabel } from '../lib/providers'

const PLACEMENT = { max: 460, min: 200 }

/**
 * The diff panel's Review button. With models to choose from it opens a menu:
 * the chat's own model first, then every other model pi offers, so a second
 * model can look over what the first one wrote. Without them it reviews
 * straight away with pi's default.
 */
export function ReviewButton({
  models,
  current,
  busy,
  disabled,
  onReview
}: {
  models: Model[]
  current: Model | null
  busy: boolean
  disabled: boolean
  onReview(model: SideModelInput | undefined): void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const placement = usePopoverPlacement(rootRef, open, PLACEMENT)

  // Row 0 is the chat's model; the rest are the other models, filtered.
  const isCurrent = (m: Model): boolean =>
    current !== null && m.provider === current.provider && m.id === current.id
  const matches = (m: Model): boolean => {
    const needle = query.trim().toLowerCase()
    return !needle || `${m.provider} ${m.name} ${m.id}`.toLowerCase().includes(needle)
  }
  // The menu is only worth opening when there is another model to pick.
  const hasOthers = models.some((m) => !isCurrent(m))
  const others = models.filter((m) => !isCurrent(m) && matches(m))
  const byProvider = new Map<string, Model[]>()
  for (const model of others) {
    byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model])
  }
  const grouped = [...byProvider.entries()]
  const flat = grouped.flatMap(([, list]) => list)
  const showCurrent = current !== null && matches(current)
  const rows: (Model | 'current')[] = [...(showCurrent ? ['current' as const] : []), ...flat]

  useEffect(() => {
    if (!open) {
      return
    }
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const run = (model: Model | null): void => {
    setOpen(false)
    onReview(model ? { provider: model.provider, modelId: model.id } : undefined)
  }
  const pickRow = (row: Model | 'current' | undefined): void => {
    if (row === 'current') {
      run(current)
    } else if (row) {
      run(row)
    }
  }

  const onClick = (): void => {
    if (!hasOthers) {
      run(current)
      return
    }
    if (!open) {
      setQuery('')
      setHighlight(0)
    }
    setOpen(!open)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pickRow(rows[highlight])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  let index = showCurrent ? 0 : -1

  return (
    <div className="review-menu" ref={rootRef}>
      <button
        type="button"
        className="diff-action"
        data-testid="review-diff"
        title="Have pi review these changes"
        aria-haspopup={hasOthers ? 'dialog' : undefined}
        aria-expanded={hasOthers ? open : undefined}
        disabled={disabled}
        onClick={onClick}
      >
        <ScanSearch size={12} />
        {busy ? 'Reviewing…' : 'Review'}
        {hasOthers && !busy && <ChevronDown size={11} className="review-chevron" />}
      </button>
      {open && (
        <div
          className={clsx('model-popover review-popover', { 'popover-below': placement.below })}
          style={{ maxHeight: placement.maxHeight }}
          data-testid="review-popover"
        >
          <div className="review-popover-title">Review with</div>
          {current && showCurrent && (
            <div className="model-list review-current">
              <button
                type="button"
                className={clsx('model-row', { 'is-highlight': highlight === 0 })}
                data-testid="review-current-model"
                onMouseEnter={() => setHighlight(0)}
                onClick={() => run(current)}
              >
                <span className="model-check">
                  <Check size={13} />
                </span>
                <span className="model-row-name">{current.name}</span>
                <span className="model-row-hint">this chat</span>
              </button>
            </div>
          )}
          <div className="model-search">
            <Search size={13} />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setHighlight(0)
              }}
              onKeyDown={onKeyDown}
              placeholder="Another model"
              spellCheck={false}
              aria-label="Search for another model"
            />
          </div>
          <div className="model-list">
            {grouped.map(([provider, list]) => (
              <div key={provider}>
                <div className="model-provider">{providerLabel(provider)}</div>
                {list.map((model) => {
                  index += 1
                  const idx = index
                  return (
                    <button
                      key={`${model.provider}:${model.id}`}
                      type="button"
                      className={clsx('model-row', { 'is-highlight': idx === highlight })}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={() => run(model)}
                    >
                      <span className="model-check" />
                      <span className="model-row-name">{model.name}</span>
                    </button>
                  )
                })}
              </div>
            ))}
            {flat.length === 0 && !showCurrent && (
              <div className="model-empty">
                {query.trim() ? 'No models match' : 'No other models'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
