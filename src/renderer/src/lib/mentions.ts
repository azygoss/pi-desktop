/**
 * @-mention helpers shared by the composer (trigger detection + insertion)
 * and the user bubble (rendering @path tokens as chips). The rules mirror
 * pi's TUI autocomplete (`@"…"` quoting for paths with spaces, @ only
 * triggers at a token boundary).
 */

export interface MentionTrigger {
  /** Index of the '@' in the text. */
  start: number
  /** Index just past the query (the cursor position). */
  end: number
  /** Path fragment typed so far (may be empty). */
  query: string
}

/** Chars that end a token — pi's PATH_DELIMITERS plus newline. */
const DELIMITERS = new Set([' ', '\t', '\n', '"', "'", '='])

function isDelimiter(ch: string | undefined): boolean {
  return ch === undefined || DELIMITERS.has(ch)
}

/** True when `pos` sits inside a code span or fenced code block. */
export function insideCode(text: string, pos: number): boolean {
  let inFence = false
  let i = 0
  while (i < pos) {
    const lineEnd = text.indexOf('\n', i)
    const end = lineEnd === -1 ? pos : Math.min(lineEnd, pos)
    const line = text.slice(i, end)
    const fence = line.match(/^\s*```/)
    if (fence) {
      // A fence line containing pos means the cursor is on the fence itself.
      if (end === pos) {
        return inFence
      }
      inFence = !inFence
    } else if (end === pos) {
      // The cursor's own line: inside a fence, or an odd number of backticks
      // before pos means an open inline code span.
      if (inFence) {
        return true
      }
      const ticks = (line.match(/`/g) ?? []).length
      if (ticks % 2 === 1) {
        return true
      }
    }
    if (lineEnd === -1) {
      break
    }
    i = lineEnd + 1
  }
  return inFence
}

/**
 * The @-mention token ending at `cursor`, or null. Mirrors pi's rules: `@`
 * must begin a token (start of text or after space/tab/quote/equals), may be
 * `@"…` for quoted paths, and must not sit inside a code span/fence.
 */
export function mentionTrigger(text: string, cursor: number): MentionTrigger | null {
  if (cursor < 0 || cursor > text.length) {
    return null
  }
  const before = text.slice(0, cursor)
  // Quoted form: an unclosed @"…" — find the last '@"' whose quote never closed.
  const quoteAt = before.lastIndexOf('@"')
  if (quoteAt !== -1 && isDelimiter(before[quoteAt - 1])) {
    const inner = before.slice(quoteAt + 2)
    if (!inner.includes('"') && !inner.includes('\n') && !insideCode(text, quoteAt)) {
      return { start: quoteAt, end: cursor, query: inner }
    }
  }
  // Plain form: token before the cursor starts with '@'.
  let tokenStart = before.length
  while (tokenStart > 0 && !DELIMITERS.has(before[tokenStart - 1]!)) {
    tokenStart -= 1
  }
  const token = before.slice(tokenStart)
  if (!token.startsWith('@')) {
    return null
  }
  if (insideCode(text, tokenStart)) {
    return null
  }
  return { start: tokenStart, end: cursor, query: token.slice(1) }
}

/** pi inserts `@path` for plain paths and `@"a b/c"` when the path has spaces. */
export function formatMention(path: string): string {
  return path.includes(' ') ? `@"${path}"` : `@${path}`
}

/** The `@path` reference appended on send: relative under cwd, else absolute. */
export function attachmentRef(path: string, cwd: string): string {
  const normalizedCwd = cwd.replace(/\/+$/, '')
  const rel =
    normalizedCwd && path.startsWith(normalizedCwd + '/')
      ? path.slice(normalizedCwd.length + 1)
      : path
  return formatMention(rel)
}

/** Append file-chip references to the outgoing message text, one per line. */
export function appendAttachmentRefs(text: string, paths: string[], cwd: string): string {
  if (paths.length === 0) {
    return text
  }
  const refs = paths.map((p) => attachmentRef(p, cwd)).join('\n')
  return text.trim().length === 0 ? refs : `${text}\n${refs}`
}

/** A raw candidate is a path when it contains '/' or a dotted extension —
 *  plain words like `@username` are left as text. */
export function looksLikePath(candidate: string): boolean {
  if (candidate.includes('/')) {
    return true
  }
  return /\.[A-Za-z0-9]{1,10}$/.test(candidate)
}

export type MentionSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; text: string; path: string }

const MENTION_RE = /@"([^"\n]+)"|@([^\s"'@=]+)/g

/**
 * Split user-message text into plain runs and @path mention chips. Only
 * boundary-anchored tokens that look like paths become mentions, so emails
 * and @names pass through untouched.
 */
export function splitMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = []
  let last = 0
  MENTION_RE.lastIndex = 0
  for (let m = MENTION_RE.exec(text); m !== null; m = MENTION_RE.exec(text)) {
    const at = m.index
    if (!isDelimiter(text[at - 1])) {
      continue // mid-word, e.g. an email address
    }
    const path = m[1] ?? m[2]!
    if (!looksLikePath(path)) {
      continue
    }
    if (at > last) {
      segments.push({ type: 'text', text: text.slice(last, at) })
    }
    segments.push({ type: 'mention', text: m[0], path })
    last = at + m[0].length
  }
  if (last < text.length) {
    segments.push({ type: 'text', text: text.slice(last) })
  }
  return segments
}
