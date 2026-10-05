import { describe, expect, it } from 'vitest'

import { buildPrReview, rightSideLines } from './pr-review'

const PATCH = ['@@ -1,3 +1,4 @@', ' one', '-two', '+TWO', '+two and a half', ' three'].join('\n')

describe('rightSideLines', () => {
  it('numbers the added and context lines of the new file', () => {
    expect([...rightSideLines(PATCH)]).toEqual([
      [1, 'one'],
      [2, 'TWO'],
      [3, 'two and a half'],
      [4, 'three']
    ])
  })

  it('follows each hunk header', () => {
    const lines = rightSideLines('@@ -10,2 +20,2 @@\n a\n+b\n\\ No newline at end of file')
    expect([...lines]).toEqual([
      [20, 'a'],
      [21, 'b']
    ])
  })
})

describe('buildPrReview', () => {
  const files = [{ filename: 'src/a.ts', patch: PATCH }, { filename: 'image.png' }]

  it('puts comments on their line when the pull request has it, signed', () => {
    const review = buildPrReview(
      [
        { path: 'src/a.ts', line: 2, lineText: 'TWO', text: 'Why upper case?' },
        { path: 'src/a.ts', line: 3, lineText: '', text: 'Off by one', author: 'pi' }
      ],
      files
    )
    expect(review.comments).toEqual([
      { path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'Why upper case?\n\n<sub>pi-bot</sub>' },
      { path: 'src/a.ts', line: 3, side: 'RIGHT', body: "Off by one\n\n<sub>pi-bot · pi's review</sub>" }
    ])
    expect(review.body).toBe('**pi-bot** · 2 review comments from Pi Desktop')
  })

  it('lists comments on lines the pull request does not have in the body', () => {
    const review = buildPrReview(
      [
        { path: 'src/a.ts', line: 2, lineText: 'changed locally', text: 'Stale line' },
        { path: 'src/b.ts', line: 7, lineText: 'const `x`', text: 'Not pushed\nyet' },
        { path: 'image.png', lineText: '', text: 'Binary', author: 'pi' }
      ],
      files
    )
    expect(review.comments).toEqual([])
    expect(review.body).toContain('3 review comments')
    expect(review.body).toContain("- `src/b.ts:7` — `const 'x'`\n  Not pushed\n  yet")
    expect(review.body).toContain('- `src/a.ts:2` — `changed locally`\n  Stale line')
    expect(review.body).toContain('- `image.png` _(pi)_\n  Binary')
  })
})
