import { Check, ChevronDown, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'

import type { Model, ThinkingLevel } from '../../../shared/pi-types'

const THINKING_LABELS: Record<string, string> = {
  off: 'Off',
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'Max'
}

interface ModelPickerProps {
  models: Model[]
  current: Model | null
  thinkingLevel: ThinkingLevel | null
  thinkingLevels: ThinkingLevel[]
  disabled?: boolean
  onSelect(provider: string, modelId: string): void
  onThinkingChange(level: ThinkingLevel): void
}

export function ModelPicker({
  models,
  current,
  thinkingLevel,
  thinkingLevels,
  disabled,
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

  const currentLabel = current?.name ?? (models.length ? 'Select model' : 'No models')
  const thinkingLabel = thinkingLevel ? (THINKING_LABELS[thinkingLevel] ?? thinkingLevel) : null

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
        {thinkingLabel && <span className="model-picker-thinking">{thinkingLabel}</span>}
        <ChevronDown size={13} className="model-picker-chevron" />
      </button>

      {open && (
        <div className="model-popover" data-testid="model-popover">
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
                <div className="model-provider">{provider}</div>
                {list.map((model) => {
                  flatIndex += 1
                  const idx = flatIndex
                  const selected =
                    current?.provider === model.provider && current?.id === model.id
                  return (
                    <button
                      key={`${model.provider}:${model.id}`}
                      type="button"
                      className={clsx('model-row', { 'is-highlight': idx === highlight })}
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
                    </button>
                  )
                })}
              </div>
            ))}
            {flat.length === 0 && <div className="model-empty">No models match</div>}
          </div>
          {thinkingLevels.length > 0 && (
            <div className="thinking-segment">
              {thinkingLevels.map((level) => (
                <button
                  key={level}
                  type="button"
                  className={clsx('thinking-segment-btn', {
                    'is-active': thinkingLevel === level
                  })}
                  onClick={() => onThinkingChange(level)}
                >
                  {THINKING_LABELS[level] ?? level}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
