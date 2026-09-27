/**
 * Turn a run of tool names into a short human summary, e.g.
 * "read 2 files, edited 1, ran 2 commands". Unknown tools fall back to
 * "<name> ×N".
 */
export function summarizeToolNames(names: string[]): string {
  let read = 0
  let edited = 0
  let commands = 0
  const other = new Map<string, number>()

  for (const raw of names) {
    const name = raw.toLowerCase()
    if (/^(read|view|cat|ls|list|find|glob|grep|search)/.test(name)) {
      read += 1
    } else if (/^(edit|write|create|apply|patch|str_replace|insert)/.test(name)) {
      edited += 1
    } else if (/^(bash|sh|shell|exec|run|terminal)/.test(name)) {
      commands += 1
    } else if (name.startsWith('browser_')) {
      other.set('browser', (other.get('browser') ?? 0) + 1)
    } else {
      other.set(raw, (other.get(raw) ?? 0) + 1)
    }
  }

  const parts: string[] = []
  if (read) {
    parts.push(`read ${read} file${read === 1 ? '' : 's'}`)
  }
  if (edited) {
    parts.push(`edited ${edited} file${edited === 1 ? '' : 's'}`)
  }
  if (commands) {
    parts.push(`ran ${commands} command${commands === 1 ? '' : 's'}`)
  }
  for (const [name, count] of other) {
    parts.push(count === 1 ? name : `${name} ×${count}`)
  }
  return parts.join(', ')
}
