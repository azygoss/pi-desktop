import { describe, expect, it } from 'vitest'

import { diffFileForUntracked } from '../../../shared/diff-parse'
import { anchorForLine, placeComments, reviewPrompt } from './review-comments'

describe('reviewPrompt', () => {
  it('numbers comments with file, line and the quoted line', () => {
    const prompt = reviewPrompt([
      { path: 'src/a.ts', line: 12, lineText: '  const b = 3', text: 'Rename this.' },
      { path: 'README.md', lineText: '', text: 'Two\nlines' }
    ])
    expect(prompt).toBe(
      'Please address these review comments on the current changes:\n\n' +
        '1. `src/a.ts:12` — `const b = 3`\n   Rename this.\n\n' +
        '2. `README.md`\n   Two\n   lines\n'
    )
  })

  it('keeps backticks in the quoted line from breaking the code span', () => {
    expect(
      reviewPrompt([{ path: 'a.md', line: 1, lineText: 'use `x`', text: 'ok' }])
    ).toContain("`a.md:1` — `use 'x'`")
  })

  it('is empty without comments', () => {
    expect(reviewPrompt([])).toBe('')
  })
})

describe('anchorForLine', () => {
  const file = diffFileForUntracked('a.ts', 'one\ntwo\nthree\n')

  it('finds the diff line for a line of the new file', () => {
    expect(anchorForLine(file, 2)).toEqual({ key: '0:1', line: 2, lineText: 'two', exact: true })
  })

  it('falls back to the first line when the diff does not show that line', () => {
    expect(anchorForLine(file, 99)).toMatchObject({ key: '0:0', exact: false })
    expect(anchorForLine(file, undefined)).toMatchObject({ key: '0:0', exact: false })
  })

  it('has nowhere to put a remark on a file without hunks', () => {
    expect(anchorForLine({ path: 'x', status: 'modified', hunks: [] }, 1)).toBeNull()
  })
})

describe('placeComments', () => {
  const file = diffFileForUntracked('a.ts', 'one\ntwo\nthree\n')
  const base = { createdAt: 0, lineText: '' }

  it('puts your comment on its line, following the text when the line moved', () => {
    const placed = placeComments(
      [file],
      [{ ...base, id: '1', path: 'a.ts', line: 7, lineText: 'three', text: 'Here' }]
    )
    expect(placed).toEqual([
      expect.objectContaining({ id: '1', key: '0:2', line: 3, fallback: false, text: 'Here' })
    ])
  })

  it("puts pi's remark on the line it names and fills in the line's text", () => {
    const [placed] = placeComments(
      [file],
      [{ ...base, id: '2', path: 'a.ts', line: 2, text: 'Bug', author: 'pi' }]
    )
    expect(placed).toMatchObject({ key: '0:1', lineText: 'two', fallback: false })
  })

  it('falls back to the first line, naming the lost line in the text', () => {
    const [placed] = placeComments(
      [file],
      [{ ...base, id: '3', path: 'a.ts', line: 40, lineText: 'gone', text: 'Old' }]
    )
    expect(placed).toMatchObject({ key: '0:0', fallback: true, text: 'Line 40: Old' })
  })

  it('leaves out comments on files the diff does not show', () => {
    expect(placeComments([file], [{ ...base, id: '4', path: 'b.ts', text: 'x' }])).toEqual([])
  })
})
