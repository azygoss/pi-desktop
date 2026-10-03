import { describe, expect, it } from 'vitest'

import { diffLines, trimContext } from './line-diff'

const kinds = (oldText: string, newText: string): string =>
  diffLines(oldText, newText)
    .map((l) => `${l.kind === 'context' ? ' ' : l.kind === 'added' ? '+' : '-'}${l.text}`)
    .join('\n')

describe('diffLines', () => {
  it('keeps shared lines as context around a change', () => {
    expect(kinds('a\nb\nc', 'a\nx\nc')).toBe(' a\n-b\n+x\n c')
  })

  it('interleaves separate changes instead of one old block and one new block', () => {
    expect(kinds('a\nb\nc\nd\ne', 'a\nB\nc\nd\nE')).toBe(' a\n-b\n+B\n c\n d\n-e\n+E')
  })

  it('handles pure insertions and deletions', () => {
    expect(kinds('a\nc', 'a\nb\nc')).toBe(' a\n+b\n c')
    expect(kinds('a\nb\nc', 'a\nc')).toBe(' a\n-b\n c')
    expect(kinds('', 'a\nb')).toBe('+a\n+b')
    expect(kinds('a', '')).toBe('-a')
  })

  it('ignores a trailing newline difference', () => {
    expect(kinds('a\n', 'a')).toBe(' a')
  })
})

describe('trimContext', () => {
  it('collapses long unchanged runs into a gap', () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const newText = oldText.replace('line 10', 'changed')
    const trimmed = trimContext(diffLines(oldText, newText), 1)
    expect(trimmed.map((l) => (l === null ? '…' : l.text))).toEqual([
      'line 9',
      'line 10',
      'changed',
      'line 11'
    ])
  })

  it('marks the gap between two distant changes', () => {
    const oldText = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n')
    const newText = oldText.replace('l1\n', 'x\n').replace('l10', 'y')
    const trimmed = trimContext(diffLines(oldText, newText), 0)
    expect(trimmed.map((l) => (l === null ? '…' : l.text))).toEqual(['l1', 'x', '…', 'l10', 'y'])
  })
})
