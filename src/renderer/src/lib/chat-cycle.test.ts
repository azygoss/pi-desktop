import { describe, expect, it } from 'vitest'

import { nextOpenChat } from './chat-cycle'

describe('nextOpenChat', () => {
  it('wraps around in both directions', () => {
    expect(nextOpenChat(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(nextOpenChat(['a', 'b', 'c'], 'a', -1)).toBe('c')
    expect(nextOpenChat(['a', 'b', 'c'], 'a', 1)).toBe('b')
  })

  it('enters the list from the home screen', () => {
    expect(nextOpenChat(['a', 'b'], null, 1)).toBe('a')
    expect(nextOpenChat(['a', 'b'], null, -1)).toBe('b')
  })

  it('has nowhere to go with one chat or none', () => {
    expect(nextOpenChat(['a'], 'a', 1)).toBeNull()
    expect(nextOpenChat([], null, 1)).toBeNull()
  })
})
