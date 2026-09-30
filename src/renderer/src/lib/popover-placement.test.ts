import { describe, expect, it } from 'vitest'

import { placePopover } from './popover-placement'

const limits = { max: 420, min: 160 }

describe('placePopover', () => {
  it('opens upward from a composer docked at the bottom', () => {
    const placement = placePopover({ top: 700, bottom: 740 }, 800, limits)
    expect(placement.below).toBe(false)
    expect(placement.maxHeight).toBe(420)
  })

  it('opens downward from a composer in the middle of the window', () => {
    const placement = placePopover({ top: 260, bottom: 380 }, 800, limits)
    expect(placement.below).toBe(true)
    expect(placement.maxHeight).toBe(800 - 380 - 12 - 8)
  })

  it('never shrinks below the minimum height', () => {
    const placement = placePopover({ top: 150, bottom: 500 }, 600, limits)
    expect(placement.maxHeight).toBe(160)
  })
})
