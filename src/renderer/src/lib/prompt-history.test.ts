import { describe, expect, it } from 'vitest'

import { pushPrompt, stepHistory } from './prompt-history'

describe('pushPrompt', () => {
  it('appends trimmed prompts and skips empty ones', () => {
    expect(pushPrompt(['a'], '  b  ')).toEqual(['a', 'b'])
    expect(pushPrompt(['a'], '   ')).toEqual(['a'])
  })

  it('moves a repeated prompt to the end instead of duplicating it', () => {
    expect(pushPrompt(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a'])
  })

  it('keeps only the newest entries', () => {
    expect(pushPrompt(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd'])
  })

  it('ignores very long prompts', () => {
    expect(pushPrompt(['a'], 'x'.repeat(5000))).toEqual(['a'])
  })
})

describe('stepHistory', () => {
  const history = ['first', 'second', 'third']

  it('starts at the newest prompt', () => {
    expect(stepHistory(history, null, 'older', '')).toEqual({ index: 2, text: 'third' })
  })

  it('walks back and stops at the oldest prompt', () => {
    expect(stepHistory(history, 2, 'older', '')).toEqual({ index: 1, text: 'second' })
    expect(stepHistory(history, 0, 'older', '')).toBeNull()
  })

  it('walks forward and restores the stashed text past the newest', () => {
    expect(stepHistory(history, 1, 'newer', 'draft')).toEqual({ index: 2, text: 'third' })
    expect(stepHistory(history, 2, 'newer', 'draft')).toEqual({ index: null, text: 'draft' })
  })

  it('does nothing when not browsing or when there is no history', () => {
    expect(stepHistory(history, null, 'newer', '')).toBeNull()
    expect(stepHistory([], null, 'older', '')).toBeNull()
  })
})
