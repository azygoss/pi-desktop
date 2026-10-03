/**
 * Automations: prompts pi runs on a schedule while the app is open. Pure
 * types and schedule math, shared by main (scheduler) and renderer (editor).
 */

export type AutomationSchedule =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string; weekdaysOnly?: boolean }

export interface Automation {
  id: string
  name: string
  prompt: string
  /** Project folder the chat runs in; '' runs it without a project. */
  cwd: string
  schedule: AutomationSchedule
  enabled: boolean
  /** Epoch ms. */
  createdAt: number
  lastRunAt?: number
  /** Session file of the most recent run, once pi has written it. */
  lastSessionPath?: string
}

export const MIN_INTERVAL_MINUTES = 5
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60
export const MAX_AUTOMATIONS = 50

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function isValidSchedule(value: unknown): value is AutomationSchedule {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const s = value as Record<string, unknown>
  if (s['kind'] === 'interval') {
    return (
      typeof s['minutes'] === 'number' &&
      Number.isInteger(s['minutes']) &&
      s['minutes'] >= MIN_INTERVAL_MINUTES &&
      s['minutes'] <= MAX_INTERVAL_MINUTES
    )
  }
  if (s['kind'] === 'daily') {
    return (
      typeof s['time'] === 'string' &&
      TIME_RE.test(s['time']) &&
      (s['weekdaysOnly'] === undefined || typeof s['weekdaysOnly'] === 'boolean')
    )
  }
  return false
}

/**
 * When the automation should next run (epoch ms), counted from its last run
 * (or its creation). A time in the past means it is due now — a run missed
 * while the app was closed happens once when it is next open.
 */
export function nextRunAt(automation: Pick<Automation, 'schedule' | 'createdAt' | 'lastRunAt'>): number {
  const base = automation.lastRunAt ?? automation.createdAt
  const schedule = automation.schedule
  if (schedule.kind === 'interval') {
    return base + schedule.minutes * 60_000
  }
  const [hours, minutes] = schedule.time.split(':').map(Number) as [number, number]
  const next = new Date(base)
  next.setHours(hours, minutes, 0, 0)
  if (next.getTime() <= base) {
    next.setDate(next.getDate() + 1)
  }
  if (schedule.weekdaysOnly) {
    while (next.getDay() === 0 || next.getDay() === 6) {
      next.setDate(next.getDate() + 1)
    }
  }
  return next.getTime()
}

/** "Every 30 minutes", "Every 2 hours", "Weekdays at 09:00". */
export function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === 'daily') {
    return `${schedule.weekdaysOnly ? 'Weekdays' : 'Every day'} at ${schedule.time}`
  }
  const m = schedule.minutes
  if (m % 1440 === 0) {
    return m === 1440 ? 'Every day' : `Every ${m / 1440} days`
  }
  if (m % 60 === 0) {
    return m === 60 ? 'Every hour' : `Every ${m / 60} hours`
  }
  return `Every ${m} minutes`
}
