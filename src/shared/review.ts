/** A review remark pi made about one line of the working-tree diff. */
export interface PiReviewComment {
  /** Repo-relative path, forward slashes. */
  path: string
  /** Line in the new file, when pi gave one. */
  line?: number
  comment: string
}

/**
 * A note on one line of a project's working-tree diff: yours, or a remark pi
 * left in a review pass. The computer keeps them per project and every
 * window and paired phone shows the same list.
 */
export interface ReviewComment {
  id: string
  path: string
  /** Line number in the new file (old file for removed lines). */
  line?: number
  /** The line the comment is about, as shown in the diff ('' when unknown). */
  lineText: string
  text: string
  /** Set on remarks pi left in a review pass; yours have none. */
  author?: 'pi'
  createdAt: number
}

/** Where a project's comments changed (broadcast to windows and phones). */
export interface ReviewCommentsChange {
  cwd: string
  comments: ReviewComment[]
}

const MAX_COMMENTS = 20
const MAX_COMMENT_CHARS = 600

/**
 * The prompt for a review pass. The reply must be machine-readable: a JSON
 * array and nothing else, so the app can pin each remark to its diff line.
 */
export const REVIEW_PROMPT = [
  'Review the uncommitted changes in this repository. Run `git status` and `git diff HEAD`',
  'yourself and read files as needed. Do not modify any file and do not run anything that does.',
  '',
  'Report only high-signal problems: definite bugs, logic errors, security issues, broken edge',
  'cases, changes that contradict each other. No style or formatting remarks, nothing a linter',
  'would catch, nothing about code the diff does not touch, and no praise.',
  '',
  'Output only a JSON array, with no prose before or after it, of at most 12 objects:',
  '{"path": "<repo-relative path>", "line": <line number in the new file>, "comment": "<one or two sentences>"}',
  'Output [] when you find nothing.'
].join('\n')

/** The first balanced top-level JSON array in `text`, or null. */
function extractArray(text: string): string | null {
  const start = text.indexOf('[')
  if (start === -1) {
    return null
  }
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '[') {
      depth += 1
    } else if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }
  return null
}

/**
 * Parse pi's review reply. Tolerates a code fence or a sentence around the
 * array; anything that is not a well-formed comment is dropped. Returns
 * null when the reply holds no JSON array at all.
 */
export function parseReviewComments(text: string): PiReviewComment[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const source = extractArray(fenced ? fenced[1]! : text) ?? extractArray(text)
  if (source === null) {
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return null
  }
  if (!Array.isArray(raw)) {
    return null
  }
  const comments: PiReviewComment[] = []
  for (const item of raw as Record<string, unknown>[]) {
    if (item === null || typeof item !== 'object') {
      continue
    }
    const path = typeof item['path'] === 'string' ? item['path'].replace(/^\.\//, '').trim() : ''
    const comment = typeof item['comment'] === 'string' ? item['comment'].trim() : ''
    if (!path || !comment || path.startsWith('/') || path.includes('..')) {
      continue
    }
    const line =
      typeof item['line'] === 'number' && Number.isInteger(item['line']) && item['line'] > 0
        ? item['line']
        : undefined
    comments.push({
      path,
      ...(line !== undefined ? { line } : {}),
      comment: comment.slice(0, MAX_COMMENT_CHARS)
    })
    if (comments.length >= MAX_COMMENTS) {
      break
    }
  }
  return comments
}
