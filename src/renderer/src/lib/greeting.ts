export function capitalizeName(name: string): string {
  if (!name) {
    return name
  }
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Time-based greeting; ~15% of the time a casual variant instead.
 * `roll` is injectable for tests.
 */
export function greetingFor(name: string, date: Date = new Date(), roll = Math.random()): string {
  const display = capitalizeName(name) || 'there'
  if (roll < 0.15) {
    return `What's on your mind, ${display}?`
  }
  const hour = date.getHours()
  const part = hour < 5 ? 'evening' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  return `Good ${part}, ${display}`
}
