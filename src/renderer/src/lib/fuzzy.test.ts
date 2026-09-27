import { describe, expect, it } from 'vitest'

import { fuzzyFilter, fuzzyScore } from './fuzzy'

describe('fuzzyScore', () => {
  it('rejects non-subsequence queries', () => {
    expect(fuzzyScore('xyz', 'hello world')).toBe(-1)
    expect(fuzzyScore('abc', 'acb')).toBe(-1)
  })

  it('matches subsequence case-insensitively', () => {
    expect(fuzzyScore('hw', 'Hello World')).toBeGreaterThan(0)
    expect(fuzzyScore('settings', 'Open Settings')).toBeGreaterThan(0)
  })

  it('prefers prefix matches over scattered ones', () => {
    expect(fuzzyScore('new', 'New chat')).toBeGreaterThan(fuzzyScore('new', 'kNow yEr Wings'))
  })

  it('prefers contiguous runs', () => {
    expect(fuzzyScore('abc', 'abc def')).toBeGreaterThan(fuzzyScore('abc', 'a x b x c'))
  })

  it('rewards word boundaries', () => {
    expect(fuzzyScore('dp', 'Diff Panel')).toBeGreaterThan(fuzzyScore('dp', 'deep'))
  })

  it('prefers shorter targets', () => {
    expect(fuzzyScore('theme', 'Theme: Dark')).toBeGreaterThan(
      fuzzyScore('theme', 'Toggle the theme between dark and light')
    )
  })
})

describe('fuzzyFilter', () => {
  it('returns input order for an empty query', () => {
    expect(fuzzyFilter('', ['b', 'a'], (s) => s)).toEqual(['b', 'a'])
    expect(fuzzyFilter('  ', ['b', 'a'], (s) => s)).toEqual(['b', 'a'])
  })

  it('sorts by score and drops non-matches', () => {
    const items = ['Fix flaky test', 'Bump dependencies', 'Profile fix']
    expect(fuzzyFilter('fix', items, (s) => s)).toEqual(['Fix flaky test', 'Profile fix'])
  })
})
