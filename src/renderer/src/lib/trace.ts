/**
 * Pure helpers for the transcript trace: shell tool output and thinking
 * previews.
 */

import { changedLines, editEntries } from './tool-summary'

export type ShellStatus =
  { kind: 'exit'; code: number } | { kind: 'timeout'; seconds: number } | { kind: 'aborted' }

// pi's bash tool appends one of these after a blank line when a command
// does not exit cleanly (see appendStatus in pi's tools/bash.js).
const STATUS_LINE =
  /(?:^|\n\n)(Command exited with code (-?\d+)|Command timed out after (\d+(?:\.\d+)?) seconds|Command aborted)\s*$/

/** Split pi's trailing shell status line off a bash tool's output. */
export function splitShellStatus(text: string): { output: string; status?: ShellStatus } {
  const match = STATUS_LINE.exec(text)
  if (!match) {
    return { output: text }
  }
  const output = text.slice(0, match.index)
  if (match[2] !== undefined) {
    return { output, status: { kind: 'exit', code: Number(match[2]) } }
  }
  if (match[3] !== undefined) {
    return { output, status: { kind: 'timeout', seconds: Number(match[3]) } }
  }
  return { output, status: { kind: 'aborted' } }
}

/** Short label for a shell status: "exit 1", "timed out", "aborted". */
export function shellStatusLabel(status: ShellStatus): string {
  switch (status.kind) {
    case 'exit':
      return `exit ${status.code}`
    case 'timeout':
      return 'timed out'
    case 'aborted':
      return 'aborted'
  }
}

/** Steps faster than this show no duration: "0.0s" is noise. */
export const MIN_SHOWN_DURATION_MS = 100

/** "0.4s", "12s", "2m 05s" — compact duration for a finished step. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${(Math.max(ms, 0) / 1000).toFixed(1)}s`
  }
  const total = Math.round(ms / 1000)
  if (total < 60) {
    return `${total}s`
  }
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`
}

const EXCERPT_CHARS = 260

function cleanLine(line: string): string {
  return line
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A line that is only a heading ("## Plan", "**Plan**"). */
const HEADING_LINE = /^\s{0,3}(?:#{1,6}\s+\S.*|\*\*[^*]+\*\*:?)\s*$/

/** Markdown-ish lines flattened into one run of prose; headings lead with a dash. */
function flatten(lines: string[]): string {
  let out = ''
  for (const raw of lines) {
    const line = cleanLine(raw)
    if (!line) {
      continue
    }
    if (out) {
      out += /[.!?:…—]$/.test(out) ? ' ' : HEADING_LINE.test(raw) ? '. ' : ' '
    }
    out += HEADING_LINE.test(raw) ? `${line.replace(/:$/, '')} —` : line
  }
  return out.replace(/ —$/, '').replace(/— \./g, '—')
}

/**
 * A short excerpt of a thinking block for its collapsed state (the UI clamps
 * it to two lines): while it streams, the tail — what pi is considering right
 * now; once done, the opening, usually a heading plus its first sentence.
 */
export function thinkingExcerpt(text: string, live: boolean): string {
  if (live) {
    // Only the tail matters; don't split a long block on every delta.
    const tail = flatten(text.slice(-EXCERPT_CHARS * 2).split('\n'))
    return tail.length > EXCERPT_CHARS ? `…${tail.slice(-EXCERPT_CHARS).trimStart()}` : tail
  }
  const head = flatten(text.slice(0, EXCERPT_CHARS * 2).split('\n'))
  return head.length > EXCERPT_CHARS ? `${head.slice(0, EXCERPT_CHARS).trimEnd()}…` : head
}

export interface PeekLine {
  sign: '+' | '-'
  text: string
}

const PEEK_PER_SIDE = 2
const PEEK_WRITE_LINES = 3

function linesOf(text: unknown): string[] {
  return typeof text === 'string' && text.length > 0 ? text.replace(/\n$/, '').split('\n') : []
}

/**
 * A few changed lines for a collapsed edit/write row. Edits drop the context
 * lines old and new share at either end, so the peek shows the change itself.
 */
export function changePeek(
  kind: 'edit' | 'write',
  args: Record<string, unknown>
): { lines: PeekLine[]; more: number } | null {
  if (kind === 'write') {
    const lines = linesOf(args['content'])
    if (lines.length === 0) {
      return null
    }
    return {
      lines: lines.slice(0, PEEK_WRITE_LINES).map((text) => ({ sign: '+', text })),
      more: Math.max(0, lines.length - PEEK_WRITE_LINES)
    }
  }
  let total = 0
  let first: { removed: string[]; added: string[] } | null = null
  for (const entry of editEntries(args)) {
    const lines = changedLines(entry.oldText, entry.newText)
    total += lines.removed.length + lines.added.length
    if (!first && lines.removed.length + lines.added.length > 0) {
      first = lines
    }
  }
  if (!first) {
    return null
  }
  const lines: PeekLine[] = [
    ...first.removed.slice(0, PEEK_PER_SIDE).map((text) => ({ sign: '-' as const, text })),
    ...first.added.slice(0, PEEK_PER_SIDE).map((text) => ({ sign: '+' as const, text }))
  ]
  return { lines, more: Math.max(0, total - lines.length) }
}
