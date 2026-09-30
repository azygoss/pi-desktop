import { Check, ChevronDown, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'

import type { Model, ThinkingLevel } from '../../../shared/pi-types'
import { supportedThinkingLevels, thinkingLevelLabel } from '../../../shared/thinking'
import { usePopoverPlacement } from '../lib/popover-placement'
import { providerLabel } from '../lib/providers'
import { EffortSlider } from './EffortSlider'
import { LevelMeter } from './Pixels'

/** Room for the whole model list plus the effort slider. */
const PLACEMENT = { max: 540, min: 220 }

interface ModelPickerProps {
  models: Model[]
  current: Model | null
  thinkingLevel: ThinkingLevel | null
  thinkingLevels: ThinkingLevel[]
  disabled?: boolean
  /** Increment to open the popover programmatically (e.g. `/model`). */
  openSignal?: number
  onSelect(provider: string, modelId: string): void
  onThinkingChange(level: ThinkingLevel): void
}

/** Tooltip for a non-active model row: its levels from thinkingLevelMap. */
function levelHint(model: Model): string {
  if (!model.reasoning) {
    return 'No reasoning'
  }
  const levels = supportedThinkingLevels(model).filter((l) => l !== 'off')
  return levels.length > 0 ? `Levels: ${levels.map(thinkingLevelLabel).join(', ')}` : ''
}

export function ModelPicker({
  models,
  current,
  thinkingLevel,
  thinkingLevels,
  disabled,
  openSignal,
  onSelect,
  onThinkingChange
}: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const byProvider = new Map<string, Model[]>()
    for (const model of models) {
      if (
        needle &&
        !`${model.provider} ${model.name} ${model.id}`.toLowerCase().includes(needle)
      ) {
        continue
      }
      const list = byProvider.get(model.provider) ?? []
      list.push(model)
      byProvider.set(model.provider, list)
    }
    return [...byProvider.entries()]
  }, [models, query])

  const flat = useMemo(() => grouped.flatMap(([, list]) => list), [grouped])

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

  // An "openSignal" bump requests the picker to open (e.g. the /model slash
  // command); derived state during render avoids a setState-in-effect cascade.
  const [seenSignal, setSeenSignal] = useState(openSignal ?? 0)
  const placement = usePopoverPlacement(rootRef, open, PLACEMENT)

  if (openSignal !== undefined && openSignal > seenSignal) {
    setSeenSignal(openSignal)
    setQuery('')
    setHighlight(0)
    setOpen(true)
  }

  function toggleOpen(): void {
    if (!open) {
      setQuery('')
      setHighlight(0)
    }
    setOpen(!open)
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const model = flat[highlight]
      if (model) {
        onSelect(model.provider, model.id)
        setOpen(false)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  // Levels come from pi's get_available_thinking_levels for the active model.
  // A model without reasoning (or one exposing only 'off') shows a muted hint
  // instead of the segment, and no level text in the trigger.
  const noReasoning =
    current?.reasoning === false ||
    (thinkingLevels.length <= 1 && thinkingLevels[0] !== undefined && thinkingLevels[0] === 'off') ||
    thinkingLevels.length === 0
  const thinkingLabel =
    !noReasoning && thinkingLevel && thinkingLevel !== 'off'
      ? thinkingLevelLabel(thinkingLevel)
      : null

  const currentLabel = current?.name ?? (models.length ? 'Select model' : 'No models')

  let flatIndex = -1

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="model-picker-trigger"
        onClick={toggleOpen}
        disabled={disabled}
        data-testid="model-picker-trigger"
      >
        <span className="model-picker-name">{currentLabel}</span>
        {thinkingLabel && thinkingLevel && (
          <span className="model-picker-thinking" title={`Thinking: ${thinkingLabel}`}>
            <LevelMeter level={thinkingLevel} />
            {thinkingLabel}
          </span>
        )}
        <ChevronDown size={12} className="model-picker-chevron" />
      </button>

      {open && (
        <div
          className={clsx('model-popover', { 'popover-below': placement.below })}
          style={{ maxHeight: placement.maxHeight }}
          data-testid="model-popover"
        >
          <div className="model-search">
            <Search size={13} />
            <input
              ref={searchRef}
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setHighlight(0)
              }}
              onKeyDown={onKeyDown}
              placeholder="Search models"
              spellCheck={false}
            />
          </div>
          <div className="model-list">
            {grouped.map(([provider, list]) => (
              <div key={provider}>
                <div className="model-provider">{providerLabel(provider)}</div>
                {list.map((model) => {
                  flatIndex += 1
                  const idx = flatIndex
                  const selected =
                    current?.provider === model.provider && current?.id === model.id
                  const hint = levelHint(model)
                  return (
                    <button
                      key={`${model.provider}:${model.id}`}
                      type="button"
                      className={clsx('model-row', { 'is-highlight': idx === highlight })}
                      title={hint || undefined}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={() => {
                        onSelect(model.provider, model.id)
                        setOpen(false)
                      }}
                    >
                      <span className="model-check">
                        {selected && <Check size={13} />}
                      </span>
                      <span className="model-row-name">{model.name}</span>
                      {!model.reasoning && <span className="model-row-hint">no reasoning</span>}
                    </button>
                  )
                })}
              </div>
            ))}
            {flat.length === 0 && <div className="model-empty">No models match</div>}
          </div>
          {noReasoning ? (
            <div className="thinking-none">
              <span className="effort-title">Thinking effort</span>
              <span>This model answers without a thinking phase</span>
            </div>
          ) : (
            <EffortSlider
              levels={thinkingLevels}
              value={thinkingLevel}
              onChange={onThinkingChange}
            />
          )}
        </div>
      )}
    </div>
  )
}
