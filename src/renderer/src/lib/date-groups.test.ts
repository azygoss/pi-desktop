import { describe, expect, it } from 'vitest'

import { dateGroupFor, groupByDate } from './date-groups'
import { capitalizeName, greetingFor } from './greeting'

const NOW = new Date('2026-09-27T15:00:00')

describe('dateGroupFor', () => {
  it('buckets by calendar day distance', () => {
    expect(dateGroupFor('2026-09-27T08:00:00', NOW)).toBe('Today')
    expect(dateGroupFor('2026-09-26T23:59:00', NOW)).toBe('Yesterday')
    expect(dateGroupFor('2026-09-22T12:00:00', NOW)).toBe('Previous 7 days')
    expect(dateGroupFor('2026-09-10T12:00:00', NOW)).toBe('Previous 30 days')
    expect(dateGroupFor('2026-01-01T00:00:00', NOW)).toBe('Older')
  })

  it('treats invalid dates as Older', () => {
    expect(dateGroupFor('not-a-date', NOW)).toBe('Older')
  })
})

describe('groupByDate', () => {
  it('returns only non-empty groups in order', () => {
    const items = [
      { modified: '2026-09-27T08:00:00' },
      { modified: '2026-09-25T08:00:00' },
      { modified: '2025-01-01T08:00:00' }
    ]
    const groups = groupByDate(items, NOW)
    expect(groups.map((g) => g.group)).toEqual(['Today', 'Previous 7 days', 'Older'])
  })
})

describe('greetingFor', () => {
  it('greets by time of day', () => {
    expect(greetingFor('alice', new Date('2026-01-01T09:00:00'), 0.5)).toBe(
      'Good morning, Alice'
    )
    expect(greetingFor('alice', new Date('2026-01-01T14:00:00'), 0.5)).toBe(
      'Good afternoon, Alice'
    )
    expect(greetingFor('alice', new Date('2026-01-01T21:00:00'), 0.5)).toBe(
      'Good evening, Alice'
    )
  })

  it('uses the casual variant for low rolls', () => {
    expect(greetingFor('alice', new Date('2026-01-01T09:00:00'), 0.05)).toBe(
      "What's on your mind, Alice?"
    )
  })

  it('falls back to "there" for empty names', () => {
    expect(greetingFor('', new Date('2026-01-01T09:00:00'), 0.5)).toBe('Good morning, there')
  })
})

describe('capitalizeName', () => {
  it('capitalizes the first letter', () => {
    expect(capitalizeName('bob')).toBe('Bob')
    expect(capitalizeName('')).toBe('')
  })
})
