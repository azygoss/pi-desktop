import { describe, expect, it } from 'vitest'

import { formatElapsed } from './live-clock'

describe('formatElapsed', () => {
  it('shows seconds under a minute', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(999)).toBe('0s')
    expect(formatElapsed(59_999)).toBe('59s')
  })

  it('pads seconds after a minute and minutes after an hour', () => {
    expect(formatElapsed(65_000)).toBe('1m 05s')
    expect(formatElapsed(3_599_000)).toBe('59m 59s')
    expect(formatElapsed(3_840_000)).toBe('1h 04m')
  })

  it('clamps clock skew to zero', () => {
    expect(formatElapsed(-500)).toBe('0s')
  })
})
