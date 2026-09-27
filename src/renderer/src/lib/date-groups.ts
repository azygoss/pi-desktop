export type DateGroup =
  | 'Today'
  | 'Yesterday'
  | 'Previous 7 days'
  | 'Previous 30 days'
  | 'Older'

export const DATE_GROUP_ORDER: DateGroup[] = [
  'Today',
  'Yesterday',
  'Previous 7 days',
  'Previous 30 days',
  'Older'
]

function startOfDay(date: Date): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const DAY_MS = 24 * 60 * 60 * 1000

export function dateGroupFor(isoTimestamp: string, now: Date = new Date()): DateGroup {
  const then = new Date(isoTimestamp)
  if (Number.isNaN(then.getTime())) {
    return 'Older'
  }
  const days = Math.floor((startOfDay(now) - startOfDay(then)) / DAY_MS)
  if (days <= 0) {
    return 'Today'
  }
  if (days === 1) {
    return 'Yesterday'
  }
  if (days <= 7) {
    return 'Previous 7 days'
  }
  if (days <= 30) {
    return 'Previous 30 days'
  }
  return 'Older'
}

export interface DateGroupedItems<T> {
  group: DateGroup
  items: T[]
}

/** Group items by their `modified` ISO timestamp into recency buckets. */
export function groupByDate<T extends { modified: string }>(
  items: T[],
  now: Date = new Date()
): DateGroupedItems<T>[] {
  const buckets = new Map<DateGroup, T[]>()
  for (const item of items) {
    const group = dateGroupFor(item.modified, now)
    const bucket = buckets.get(group)
    if (bucket) {
      bucket.push(item)
    } else {
      buckets.set(group, [item])
    }
  }
  return DATE_GROUP_ORDER.filter((g) => buckets.has(g)).map((g) => ({
    group: g,
    items: buckets.get(g)!
  }))
}
