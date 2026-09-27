import { describe, expect, it } from 'vitest'

import { collapseWhitespace, truncateText } from './text'

describe('collapseWhitespace', () => {
  it('collapses runs of whitespace into single spaces', () => {
    expect(collapseWhitespace('  hello\n\tworld   again  ')).toBe('hello world again')
  })

  it('returns empty string for whitespace-only input', () => {
    expect(collapseWhitespace('   \n\t ')).toBe('')
  })
})

describe('truncateText', () => {
  it('returns the text unchanged when within the limit', () => {
    expect(truncateText('short', 10)).toBe('short')
  })

  it('truncates with an ellipsis when over the limit', () => {
    const result = truncateText('a'.repeat(100), 80)
    expect(result).toHaveLength(80)
    expect(result.endsWith('…')).toBe(true)
  })
})
