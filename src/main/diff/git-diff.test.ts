import { describe, expect, it } from 'vitest'

import { parseShortstat } from './git-diff'

describe('parseShortstat', () => {
  it('reads insertions and deletions', () => {
    expect(parseShortstat(' 3 files changed, 12 insertions(+), 4 deletions(-)\n')).toEqual({
      added: 12,
      removed: 4
    })
  })

  it('handles a one-sided or empty stat', () => {
    expect(parseShortstat(' 1 file changed, 1 insertion(+)')).toEqual({ added: 1, removed: 0 })
    expect(parseShortstat('')).toEqual({ added: 0, removed: 0 })
  })
})
