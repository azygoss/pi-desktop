import { describe, expect, it } from 'vitest'

import { parseReviewComments } from './review'

describe('parseReviewComments', () => {
  it('reads a bare array', () => {
    expect(
      parseReviewComments('[{"path":"src/a.ts","line":12,"comment":"Off by one."}]')
    ).toEqual([{ path: 'src/a.ts', line: 12, comment: 'Off by one.' }])
  })

  it('reads an array inside a fence with prose around it', () => {
    const reply = 'Here is the review:\n```json\n[{"path":"./b.ts","comment":"Uses [x] wrongly"}]\n```\nDone.'
    expect(parseReviewComments(reply)).toEqual([{ path: 'b.ts', comment: 'Uses [x] wrongly' }])
  })

  it('drops malformed entries and unsafe paths', () => {
    const reply = JSON.stringify([
      { path: 'ok.ts', line: 0, comment: 'line zero is not a line' },
      { path: '../outside', line: 1, comment: 'no' },
      { path: '/etc/passwd', line: 1, comment: 'no' },
      { path: 'x.ts', comment: '   ' },
      'nonsense'
    ])
    expect(parseReviewComments(reply)).toEqual([
      { path: 'ok.ts', comment: 'line zero is not a line' }
    ])
  })

  it('tells "nothing found" from "no array"', () => {
    expect(parseReviewComments('[]')).toEqual([])
    expect(parseReviewComments('I could not review this.')).toBeNull()
    expect(parseReviewComments('[not json')).toBeNull()
  })
})
