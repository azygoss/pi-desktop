import { describe, expect, it } from 'vitest'

import { reviewPrompt } from './review-comments'

describe('reviewPrompt', () => {
  it('numbers comments with file, line and the quoted line', () => {
    const prompt = reviewPrompt([
      { id: '1', path: 'src/a.ts', line: 12, lineText: '  const b = 3', text: 'Rename this.' },
      { id: '2', path: 'README.md', lineText: '', text: 'Two\nlines' }
    ])
    expect(prompt).toBe(
      'Please address these review comments on the current changes:\n\n' +
        '1. `src/a.ts:12` — `const b = 3`\n   Rename this.\n\n' +
        '2. `README.md`\n   Two\n   lines\n'
    )
  })

  it('keeps backticks in the quoted line from breaking the code span', () => {
    expect(
      reviewPrompt([{ id: '1', path: 'a.md', line: 1, lineText: 'use `x`', text: 'ok' }])
    ).toContain("`a.md:1` — `use 'x'`")
  })

  it('is empty without comments', () => {
    expect(reviewPrompt([])).toBe('')
  })
})
