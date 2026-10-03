import { describe, expect, it } from 'vitest'

import { describeSchedule, isValidSchedule, nextRunAt } from './automations'

const at = (y: number, mo: number, d: number, h: number, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi).getTime()

describe('nextRunAt', () => {
  it('adds the interval to the last run, or to the creation time', () => {
    const schedule = { kind: 'interval' as const, minutes: 30 }
    expect(nextRunAt({ schedule, createdAt: 1000 })).toBe(1000 + 30 * 60_000)
    expect(nextRunAt({ schedule, createdAt: 1000, lastRunAt: 5000 })).toBe(5000 + 30 * 60_000)
  })

  it('picks the next daily time after the last run', () => {
    const schedule = { kind: 'daily' as const, time: '09:00' }
    // Created at 08:00 → today 09:00; last ran at 09:00 → tomorrow 09:00.
    expect(nextRunAt({ schedule, createdAt: at(2026, 6, 15, 8) })).toBe(at(2026, 6, 15, 9))
    expect(
      nextRunAt({ schedule, createdAt: at(2026, 6, 15, 8), lastRunAt: at(2026, 6, 15, 9) })
    ).toBe(at(2026, 6, 16, 9))
  })

  it('skips the weekend when asked', () => {
    const schedule = { kind: 'daily' as const, time: '09:00', weekdaysOnly: true }
    // 2026-06-19 is a Friday; after Friday's run the next is Monday the 22nd.
    expect(new Date(at(2026, 6, 19, 9)).getDay()).toBe(5)
    expect(nextRunAt({ schedule, createdAt: 0, lastRunAt: at(2026, 6, 19, 9) })).toBe(
      at(2026, 6, 22, 9)
    )
  })
})

describe('isValidSchedule', () => {
  it('accepts sane schedules and rejects the rest', () => {
    expect(isValidSchedule({ kind: 'interval', minutes: 30 })).toBe(true)
    expect(isValidSchedule({ kind: 'daily', time: '23:59', weekdaysOnly: true })).toBe(true)
    for (const bad of [
      null,
      { kind: 'interval', minutes: 1 },
      { kind: 'interval', minutes: 2.5 },
      { kind: 'daily', time: '24:00' },
      { kind: 'daily', time: '9:00' },
      { kind: 'cron', expr: '* * * * *' }
    ]) {
      expect(isValidSchedule(bad)).toBe(false)
    }
  })
})

describe('describeSchedule', () => {
  it('reads naturally', () => {
    expect(describeSchedule({ kind: 'interval', minutes: 30 })).toBe('Every 30 minutes')
    expect(describeSchedule({ kind: 'interval', minutes: 60 })).toBe('Every hour')
    expect(describeSchedule({ kind: 'interval', minutes: 180 })).toBe('Every 3 hours')
    expect(describeSchedule({ kind: 'interval', minutes: 1440 })).toBe('Every day')
    expect(describeSchedule({ kind: 'daily', time: '09:00', weekdaysOnly: true })).toBe(
      'Weekdays at 09:00'
    )
  })
})
