import type { DisplayMessage, ToolRun } from '../../../shared/chat-view'
import { toolCallSummary } from './tool-summary'

/**
 * Find-in-chat helpers. The transcript is windowed, so searching happens on
 * the message model; DOM ranges are built separately in ChatView.
 */

/** Case-insensitive occurrence count of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0
  }
  const lower = haystack.toLowerCase()
  const q = needle.toLowerCase()
  let count = 0
  let pos = 0
  while ((pos = lower.indexOf(q, pos)) !== -1) {
    count += 1
    pos += q.length
  }
  return count
}

/**
 * The searchable text of one message: user text, assistant text blocks and
 * the one-line summaries shown on tool cards. Tool output bodies, thinking
 * and images are excluded by design.
 */
export function messageSearchText(
  message: DisplayMessage,
  toolRuns: Record<string, ToolRun>,
  cwd = ''
): string {
  if (message.kind === 'user') {
    return message.text
  }
  if (message.kind === 'bash') {
    return message.command
  }
  if (message.kind !== 'assistant') {
    return ''
  }
  const parts: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'text') {
      parts.push(block.text)
    } else if (block.type === 'toolCall') {
      const run = toolRuns[block.id]
      const summary = toolCallSummary(
        run?.name ?? block.name,
        run?.args ?? block.arguments,
        cwd,
        run?.result?.details as Record<string, unknown> | undefined
      )
      // The card shows "<tool> <summary>" — matching either side is useful.
      parts.push(`${block.name} ${summary}`.trim())
    }
  }
  return parts.join('\n')
}

export interface FindMatch {
  /** Index into ChatState.messages. */
  messageIndex: number
  /** Number of query occurrences inside this message's searchable text. */
  count: number
}

/**
 * Per-message match list for a query — preserving transcript order and the
 * occurrence count so the UI can label "3 of 12" and locate the current hit.
 */
export function findMatches(
  messages: DisplayMessage[],
  toolRuns: Record<string, ToolRun>,
  query: string,
  cwd = ''
): FindMatch[] {
  const q = query.trim()
  if (!q) {
    return []
  }
  const matches: FindMatch[] = []
  messages.forEach((message, messageIndex) => {
    const count = countOccurrences(messageSearchText(message, toolRuns, cwd), q)
    if (count > 0) {
      matches.push({ messageIndex, count })
    }
  })
  return matches
}

/** Total occurrence count across a match list (the "of N" denominator). */
export function totalOccurrences(matches: FindMatch[]): number {
  return matches.reduce((sum, m) => sum + m.count, 0)
}

/**
 * Locate the match entry containing global occurrence `ordinal` (0-based).
 * Returns the entry's position in `matches` plus the occurrence index
 * within that message.
 */
export function locateOccurrence(
  matches: FindMatch[],
  ordinal: number
): { matchIndex: number; occurrenceInMessage: number } | null {
  let seen = 0
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!
    if (ordinal < seen + m.count) {
      return { matchIndex: i, occurrenceInMessage: ordinal - seen }
    }
    seen += m.count
  }
  return null
}
