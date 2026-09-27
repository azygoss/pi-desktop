import type { Model, ThinkingLevel } from './pi-types'

/** Canonical thinking level order (docs/rpc-commands.md). */
export const THINKING_LEVEL_ORDER: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max'
}

export function thinkingLevelLabel(level: ThinkingLevel): string {
  return THINKING_LEVEL_LABELS[level] ?? level
}

/**
 * Thinking levels a model supports, derived from its `thinkingLevelMap`
 * (null = unsupported, missing key = provider default = supported). Models
 * without reasoning support return `['off']`.
 *
 * This is a hint for listing non-active models; the authoritative list for
 * the active model is pi's `get_available_thinking_levels`.
 */
export function supportedThinkingLevels(
  model: Pick<Model, 'reasoning'> & Partial<Pick<Model, 'thinkingLevelMap'>>
): ThinkingLevel[] {
  if (!model.reasoning) {
    return ['off']
  }
  const map = model.thinkingLevelMap
  if (!map) {
    return [...THINKING_LEVEL_ORDER]
  }
  return THINKING_LEVEL_ORDER.filter((level) => map[level] !== null)
}

/** True when the model offers real thinking levels (more than just 'off'). */
export function modelHasThinking(
  model: (Pick<Model, 'reasoning'> & Partial<Pick<Model, 'thinkingLevelMap'>>) | null | undefined
): boolean {
  if (!model || model.reasoning !== true) {
    return false
  }
  return supportedThinkingLevels(model).some((level) => level !== 'off')
}
