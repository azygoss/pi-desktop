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
    } else if (name.startsWith('computer_')) {
      other.set('computer', (other.get('computer') ?? 0) + 1)
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

const CHORD_MODIFIERS: Record<string, string> = {
  cmd: '⌘',
  command: '⌘',
  super: '⌘',
  shift: '⇧',
  alt: '⌥',
  option: '⌥',
  ctrl: '⌃',
  control: '⌃'
}

const CHORD_KEYS: Record<string, string> = {
  return: 'Return',
  enter: 'Return',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  space: 'Space',
  delete: 'Delete',
  backspace: 'Delete',
  forwarddelete: 'Forward Delete',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  home: 'Home',
  end: 'End',
  pageup: 'Page Up',
  pagedown: 'Page Down'
}

/** "cmd+shift+s" → "⌘⇧S"; single chars uppercase, named keys title-cased. */
export function formatKeyChord(chord: string): string {
  const parts = chord.split('+').filter((p) => p.trim() !== '')
  const mods: string[] = []
  let key = ''
  for (const part of parts) {
    const mod = CHORD_MODIFIERS[part.trim().toLowerCase()]
    if (mod) {
      mods.push(mod)
    } else {
      key = part.trim()
    }
  }
  const named = CHORD_KEYS[key.toLowerCase()]
  const rendered = named ?? (key.length === 1 ? key.toUpperCase() : key)
  return mods.join('') + rendered
}

interface ComputerDetails {
  element?: { label?: string; role?: string }
  approved?: boolean
}

function argStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v ? v : undefined
}

/**
 * Per-call summary for computer_* tools shown inside the tool card, e.g.
 * `Clicked "Save" in Finder`. `details` (the tool result details) upgrades the
 * generic element id to its AX label when the helper returned one.
 */
export function computerToolSummary(
  name: string,
  args: Record<string, unknown>,
  details?: Record<string, unknown>
): string {
  const app = argStr(args, 'app')
  const where = app ? ` in ${app}` : ''
  const d = (details ?? {}) as ComputerDetails
  switch (name) {
    case 'computer_state':
      return `Read ${app ?? 'app'}${args['screenshot'] === true ? ' · screenshot' : ''}`
    case 'computer_click': {
      const label = d.element?.label ? `"${d.element.label}"` : undefined
      const target =
        label ??
        (args['element'] !== undefined ? `element ${String(args['element'])}` : 'element')
      return `Clicked ${target}${where}`
    }
    case 'computer_set_value':
      return `Set value${where}`
    case 'computer_type': {
      const text = argStr(args, 'text')
      return `Typed ${text?.length ?? 0} characters${where}`
    }
    case 'computer_key':
      return `Pressed ${formatKeyChord(argStr(args, 'key') ?? '?')}${where}`
    case 'computer_scroll':
      return `Scrolled ${argStr(args, 'direction') ?? ''}${where}`.replace('  ', ' ')
    case 'computer_drag':
      return `Dragged${where}`
    case 'computer_action':
      return `${argStr(args, 'action') ?? 'action'}${where}`
    case 'computer_screenshot':
      return `Screenshot of ${app ?? 'screen'}`
    case 'computer_apps':
      return 'Listed apps'
    case 'computer_confirm':
      if (d.approved === true) {
        return 'Approved'
      }
      if (d.approved === false) {
        return 'Declined'
      }
      return 'Asked for approval'
    default:
      return name
  }
}

/**
 * When every grouped run is a computer_* tool against the same app, the group
 * reads "Used Finder · 6 actions" instead of the generic "Ran N tools".
 */
export function computerGroupApp(
  runs: { name: string; args: Record<string, unknown> }[]
): string | null {
  if (runs.length === 0 || runs.some((r) => !r.name.startsWith('computer_'))) {
    return null
  }
  const apps = new Set(
    runs.map((r) => argStr(r.args, 'app')).filter((a): a is string => !!a)
  )
  return apps.size === 1 ? [...apps][0]! : null
}
