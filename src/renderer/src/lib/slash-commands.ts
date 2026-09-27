import type { PiCommandInfo } from '../../../shared/pi-types'

export interface SlashCommandItem {
  /** Command name without the leading slash. */
  name: string
  description?: string
  /** 'app' commands are handled locally; the rest are sent to pi as prompts. */
  source: 'app' | 'skill' | 'prompt' | 'extension'
  /** Whether the command consumes the text after it as an argument. */
  takesArgs?: boolean
  /** Only meaningful for an open chat with content. */
  chatOnly?: boolean
  /** Only runnable while the chat is not streaming. */
  idleOnly?: boolean
  /** Runs pi's interactive TUI in a terminal tab instead of the RPC client. */
  terminal?: boolean
  /** Extra muted hint shown on the palette row (e.g. 'opens in terminal'). */
  hint?: string
}

const TERMINAL_HINT = 'opens in terminal'

/**
 * Every pi built-in slash command (docs/slash-commands.md), surfaced as an
 * app command. Commands pi only implements in its TUI run in a terminal tab.
 */
export const APP_COMMANDS: SlashCommandItem[] = [
  // Models and settings
  { name: 'settings', description: 'Open app settings', source: 'app' },
  { name: 'model', description: 'Select a model', source: 'app', takesArgs: true },
  {
    name: 'thinking',
    description: 'Set the thinking level',
    source: 'app',
    takesArgs: true,
    chatOnly: true
  },
  {
    name: 'scoped-models',
    description: 'Configure models used by interactive cycling',
    source: 'app',
    terminal: true,
    hint: TERMINAL_HINT
  },
  {
    name: 'login',
    description: 'Add provider authentication',
    source: 'app',
    terminal: true,
    takesArgs: true,
    hint: TERMINAL_HINT
  },
  {
    name: 'logout',
    description: 'Remove provider authentication',
    source: 'app',
    terminal: true,
    hint: TERMINAL_HINT
  },
  {
    name: 'llama',
    description: 'Manage models on the llama.cpp router',
    source: 'app',
    terminal: true,
    hint: TERMINAL_HINT
  },

  // Sessions and context
  { name: 'new', description: 'New chat', source: 'app' },
  { name: 'resume', description: 'Search chats', source: 'app' },
  {
    name: 'name',
    description: 'Set the chat name, or show it when omitted',
    source: 'app',
    takesArgs: true,
    chatOnly: true
  },
  {
    name: 'session',
    description: 'Session info and stats',
    source: 'app',
    chatOnly: true
  },
  { name: 'tree', description: 'Show the session tree', source: 'app', chatOnly: true },
  {
    name: 'fork',
    description: 'Fork from an earlier message',
    source: 'app',
    chatOnly: true,
    idleOnly: true
  },
  {
    name: 'clone',
    description: 'Duplicate the current chat',
    source: 'app',
    chatOnly: true,
    idleOnly: true
  },
  {
    name: 'compact',
    description: 'Compact context (optional instructions)',
    source: 'app',
    takesArgs: true,
    chatOnly: true
  },
  {
    name: 'import',
    description: 'Import a .jsonl session',
    source: 'app',
    takesArgs: true
  },

  // Export and share
  { name: 'copy', description: 'Copy the last reply', source: 'app', chatOnly: true },
  {
    name: 'export',
    description: 'Export as HTML (or .jsonl with a path)',
    source: 'app',
    takesArgs: true,
    chatOnly: true
  },
  {
    name: 'share',
    description: 'Upload the session and get a viewer link',
    source: 'app',
    terminal: true,
    chatOnly: true,
    idleOnly: true,
    hint: TERMINAL_HINT
  },
  {
    name: 'bug',
    description: 'Prepare a bug report for the pi developers',
    source: 'app',
    terminal: true,
    takesArgs: true,
    chatOnly: true,
    idleOnly: true,
    hint: TERMINAL_HINT
  },

  // Runtime and project
  {
    name: 'trust',
    description: 'Save a project trust decision',
    source: 'app',
    terminal: true,
    hint: TERMINAL_HINT
  },
  {
    name: 'reload',
    description: 'Restart pi and reload resources',
    source: 'app',
    chatOnly: true
  },
  { name: 'hotkeys', description: 'Show keyboard shortcuts', source: 'app' },
  { name: 'changelog', description: 'Open the pi changelog', source: 'app' },
  { name: 'quit', description: 'Quit Pi Desktop', source: 'app' }
]

/**
 * If the composer text is a single `/token` still being typed (no whitespace),
 * return the token without the slash; otherwise null.
 */
export function slashQuery(text: string): string | null {
  const match = /^\/([^\s]*)$/.exec(text)
  return match ? match[1]! : null
}

/** Parse a composer send like `/name foo bar` into command + args. */
export function parseSlashSend(text: string): { command: string; args: string } | null {
  const match = /^\/([^\s]+)(?:\s+(.*))?$/.exec(text.trim())
  if (!match) {
    return null
  }
  return { command: match[1]!, args: match[2]?.trim() ?? '' }
}

function toItem(command: PiCommandInfo): SlashCommandItem {
  return {
    name: command.name,
    description: command.description,
    source: command.source === 'skill' || command.source === 'prompt' ? command.source : 'extension'
  }
}

const GROUP_ORDER: SlashCommandItem['source'][] = ['app', 'skill', 'prompt', 'extension']

export const GROUP_LABELS: Record<SlashCommandItem['source'], string> = {
  app: 'App',
  skill: 'Skills',
  prompt: 'Prompts',
  extension: 'Extensions'
}

/**
 * Merge app commands with pi's catalog, filter by the typed token (matching
 * name AND description), and return items grouped: App, Skills, Prompts,
 * Extensions. Groups are returned in order with each group sorted by name.
 */
export function filterSlashCommands(
  piCommands: PiCommandInfo[],
  query: string,
  inChat: boolean,
  streaming = false
): { label: string; items: SlashCommandItem[] }[] {
  const needle = query.toLowerCase()
  const matches = (item: SlashCommandItem) =>
    needle === '' ||
    item.name.toLowerCase().includes(needle) ||
    (item.description?.toLowerCase().includes(needle) ?? false)

  const items: SlashCommandItem[] = [
    ...APP_COMMANDS.filter(
      (c) => (inChat || !c.chatOnly) && (!streaming || !c.idleOnly) && matches(c)
    ),
    ...piCommands.map(toItem).filter(matches)
  ]

  const groups: { label: string; items: SlashCommandItem[] }[] = []
  for (const source of GROUP_ORDER) {
    const group = items
      .filter((i) => i.source === source)
      .sort((a, b) => a.name.localeCompare(b.name))
    if (group.length > 0) {
      groups.push({ label: GROUP_LABELS[source], items: group })
    }
  }
  return groups
}

/** Flatten grouped slash items into a single navigable list. */
export function flattenSlashGroups(
  groups: { label: string; items: SlashCommandItem[] }[]
): SlashCommandItem[] {
  return groups.flatMap((g) => g.items)
}

export function findAppCommand(name: string): SlashCommandItem | undefined {
  return APP_COMMANDS.find((c) => c.name === name)
}
