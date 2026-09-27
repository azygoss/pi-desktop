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
}

export const APP_COMMANDS: SlashCommandItem[] = [
  { name: 'new', description: 'New chat', source: 'app' },
  { name: 'name', description: 'Rename this chat', source: 'app', takesArgs: true, chatOnly: true },
  {
    name: 'compact',
    description: 'Compact context now (optional instructions)',
    source: 'app',
    takesArgs: true,
    chatOnly: true
  },
  { name: 'export', description: 'Export chat as HTML', source: 'app', chatOnly: true },
  { name: 'model', description: 'Pick a model', source: 'app' },
  { name: 'thinking', description: 'Set thinking level', source: 'app' }
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

/**
 * Merge app commands with pi's catalog and filter by the typed token.
 * App commands sort first, then pi commands alphabetically.
 */
export function filterSlashCommands(
  piCommands: PiCommandInfo[],
  query: string,
  inChat: boolean
): SlashCommandItem[] {
  const needle = query.toLowerCase()
  const matches = (item: SlashCommandItem) =>
    needle === '' || item.name.toLowerCase().includes(needle)

  const app = APP_COMMANDS.filter((c) => (inChat || !c.chatOnly) && matches(c))
  const pi = piCommands
    .map(toItem)
    .filter(matches)
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...app, ...pi]
}

export function isAppCommand(name: string): boolean {
  return APP_COMMANDS.some((c) => c.name === name)
}
