export type ToolCategory =
  | 'read'
  | 'edit'
  | 'create'
  | 'run'
  | 'search'
  | 'browser'
  | 'computer'
  | 'other'

export function toolCategory(name: string): ToolCategory {
  const n = name.toLowerCase()
  if (n.startsWith('browser_')) {
    return 'browser'
  }
  if (n.startsWith('computer_')) {
    return 'computer'
  }
  if (/^(bash|sh|shell|exec|run|terminal)/.test(n)) {
    return 'run'
  }
  if (/^(edit|patch|str_replace|insert|apply)/.test(n)) {
    return 'edit'
  }
  if (/^(write|create)/.test(n)) {
    return 'create'
  }
  if (/^(grep|find|ls|list|glob|search)/.test(n)) {
    return 'search'
  }
  if (/^(read|view|cat)/.test(n)) {
    return 'read'
  }
  return 'other'
}

function countLines(text: string | undefined): number {
  if (!text) {
    return 0
  }
  return text.split('\n').length
}

export interface EditEntry {
  oldText?: string
  newText?: string
}

/**
 * The lines an edit actually changes: context that old and new text share
 * at either end (models pass it to anchor the replacement) is dropped.
 */
export function changedLines(
  oldText: unknown,
  newText: unknown
): { removed: string[]; added: string[] } {
  const split = (text: unknown): string[] =>
    typeof text === 'string' && text.length > 0 ? text.replace(/\n$/, '').split('\n') : []
  let removed = split(oldText)
  let added = split(newText)
  let lead = 0
  while (lead < removed.length && lead < added.length && removed[lead] === added[lead]) {
    lead += 1
  }
  removed = removed.slice(lead)
  added = added.slice(lead)
  let trail = 0
  while (
    trail < removed.length &&
    trail < added.length &&
    removed[removed.length - 1 - trail] === added[added.length - 1 - trail]
  ) {
    trail += 1
  }
  return {
    removed: removed.slice(0, removed.length - trail),
    added: added.slice(0, added.length - trail)
  }
}

export function editEntries(args: Record<string, unknown>): EditEntry[] {
  if (Array.isArray(args['edits'])) {
    return args['edits'] as EditEntry[]
  }
  if (typeof args['oldText'] === 'string' || typeof args['newText'] === 'string') {
    return [args as EditEntry]
  }
  return []
}

export interface GroupSummary {
  /** "Edited 2 files, ran 3 commands" — ordered by first occurrence. */
  text: string
  /** Line diff across edit/write calls; undefined when none are present. */
  diff?: { added: number; removed: number }
  /** How many runs finished with an error. */
  failed: number
  running: number
}

/**
 * Claude-style natural summary for a run of tool calls, e.g.
 * "Edited 2 files, ran 3 commands, read 4 files".
 */
export function summarizeToolRuns(
  runs: { name: string; args: Record<string, unknown>; status: string }[]
): GroupSummary {
  const counts = new Map<ToolCategory, number>()
  const order: ToolCategory[] = []
  let added = 0
  let removed = 0
  let hasDiff = false
  let failed = 0
  let running = 0

  for (const run of runs) {
    const cat = toolCategory(run.name)
    if (!counts.has(cat)) {
      order.push(cat)
    }
    counts.set(cat, (counts.get(cat) ?? 0) + 1)
    if (run.status === 'error') {
      failed += 1
    }
    if (run.status === 'running') {
      running += 1
    }
    if (cat === 'edit') {
      for (const entry of editEntries(run.args)) {
        const lines = changedLines(entry.oldText, entry.newText)
        removed += lines.removed.length
        added += lines.added.length
        hasDiff = true
      }
    } else if (cat === 'create') {
      const content = run.args['content']
      added += countLines(typeof content === 'string' ? content : undefined)
      hasDiff = true
    }
  }

  const phrase = (cat: ToolCategory, n: number): string => {
    const plural = (word: string) => (n === 1 ? word : `${word}s`)
    switch (cat) {
      case 'read':
        return `read ${n === 1 ? 'a file' : `${n} files`}`
      case 'edit':
        return `edited ${n === 1 ? 'a file' : `${n} files`}`
      case 'create':
        return `created ${n === 1 ? 'a file' : `${n} files`}`
      case 'run':
        return `ran ${n === 1 ? 'a command' : `${n} commands`}`
      case 'search':
        return n === 1 ? 'searched' : `searched ${n} times`
      case 'browser':
        return `used the browser${n > 1 ? ` (${n} actions)` : ''}`
      case 'computer':
        return `used the computer${n > 1 ? ` (${n} actions)` : ''}`
      default:
        return `used ${n} other ${plural('tool')}`
    }
  }

  const text = order.map((cat) => phrase(cat, counts.get(cat)!)).join(', ')
  const summary: GroupSummary = {
    text: text.charAt(0).toUpperCase() + text.slice(1),
    failed,
    running
  }
  if (hasDiff) {
    summary.diff = { added, removed }
  }
  return summary
}

function relativePath(p: string, cwd: string): string {
  if (cwd && p.startsWith(cwd)) {
    const rest = p.slice(cwd.length).replace(/^[/\\]/, '')
    return rest || p
  }
  return p
}

function argPath(args: Record<string, unknown>): string | undefined {
  const p = args['path'] ?? args['file'] ?? args['filePath'] ?? args['file_path']
  return typeof p === 'string' ? p : undefined
}

/**
 * The one-line summary a tool card shows next to the tool name — also the
 * searchable line find-in-chat indexes for tool calls.
 */
export function toolCallSummary(
  name: string,
  args: Record<string, unknown>,
  cwd = '',
  details?: Record<string, unknown>
): string {
  if (name.startsWith('computer_')) {
    return computerToolSummary(name, args, details)
  }
  if (toolCategory(name) === 'run') {
    return typeof args['command'] === 'string' ? (args['command'] as string) : ''
  }
  const p = argPath(args)
  if (p) {
    return relativePath(p, cwd)
  }
  const firstString = Object.values(args).find((v) => typeof v === 'string')
  return typeof firstString === 'string' ? firstString.slice(0, 120) : ''
}

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
