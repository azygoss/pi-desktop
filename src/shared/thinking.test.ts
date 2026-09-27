import { describe, expect, it } from 'vitest'

import type { Model } from './pi-types'
import {
  modelHasThinking,
  supportedThinkingLevels,
  thinkingLevelLabel
} from './thinking'

function model(over: Partial<Model> = {}): Model {
  return {
    id: 'm',
    name: 'M',
    api: 'test',
    provider: 'test',
    baseUrl: 'https://example.invalid',
    reasoning: true,
    input: ['text'],
    contextWindow: 1000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...over
  }
}

describe('supportedThinkingLevels', () => {
  it('returns all levels for a reasoning model without a map', () => {
    expect(supportedThinkingLevels(model())).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
  })

  it('returns only off for a non-reasoning model', () => {
    expect(supportedThinkingLevels(model({ reasoning: false }))).toEqual(['off'])
  })

  it('drops levels mapped to null, keeps missing keys', () => {
    const m = model({
      thinkingLevelMap: { high: 'x', xhigh: null, max: null, off: null }
    })
    expect(supportedThinkingLevels(m)).toEqual(['minimal', 'low', 'medium', 'high'])
  })

  it('keeps canonical order regardless of map key order', () => {
    const m = model({ thinkingLevelMap: { high: 'h', minimal: 'm' } })
    const levels = supportedThinkingLevels(m)
    expect(levels.indexOf('minimal')).toBeLessThan(levels.indexOf('high'))
    expect(levels.indexOf('high')).toBeLessThan(levels.indexOf('xhigh'))
  })
})

describe('modelHasThinking', () => {
  it('is false for null/non-reasoning/off-only models', () => {
    expect(modelHasThinking(null)).toBe(false)
    expect(modelHasThinking(model({ reasoning: false }))).toBe(false)
    expect(
      modelHasThinking(
        model({
          reasoning: true,
          thinkingLevelMap: {
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: null,
            max: null
          }
        })
      )
    ).toBe(false)
  })

  it('is true for a reasoning model with levels', () => {
    expect(modelHasThinking(model())).toBe(true)
    expect(modelHasThinking(model({ thinkingLevelMap: { high: 'x' } }))).toBe(true)
  })
})

describe('thinkingLevelLabel', () => {
  it('labels every level', () => {
    expect(thinkingLevelLabel('xhigh')).toBe('XHigh')
    expect(thinkingLevelLabel('max')).toBe('Max')
    expect(thinkingLevelLabel('medium')).toBe('Med')
    expect(thinkingLevelLabel('off')).toBe('Off')
  })
})
