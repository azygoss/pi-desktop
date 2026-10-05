import type { DiffFile } from '../../../shared/diff-parse'
import type { ReviewComment } from '../../../shared/review'

export type { ReviewComment }

/**
 * Where a remark about `line` of the new file belongs in a parsed diff
 * file: the `hunk:line` key of that line, or of the file's first line when
 * the diff does not show it.
 */
export function anchorForLine(
  file: DiffFile,
  line: number | undefined
): { key: string; line?: number; lineText: string; exact: boolean } | null {
  let first: { key: string; line?: number; lineText: string; exact: boolean } | null = null
  for (let i = 0; i < file.hunks.length; i++) {
    const hunk = file.hunks[i]!
    for (let j = 0; j < hunk.lines.length; j++) {
      const diffLine = hunk.lines[j]!
      const here = {
        key: `${i}:${j}`,
        line: diffLine.newNo ?? diffLine.oldNo,
        lineText: diffLine.text
      }
      if (line !== undefined && diffLine.newNo === line) {
        return { ...here, exact: true }
      }
      first ??= { ...here, exact: false }
    }
  }
  return first
}

const MAX_QUOTED = 120

/**
 * The prompt that hands review comments to pi: one numbered item per
 * comment with its file, line and the line's text, so pi can find each spot
 * without the diff in front of it.
 */
export function reviewPrompt(
  comments: readonly Pick<ReviewComment, 'path' | 'line' | 'lineText' | 'text'>[]
): string {
  if (comments.length === 0) {
    return ''
  }
  const items = comments.map((comment, i) => {
    const where = comment.line !== undefined ? `${comment.path}:${comment.line}` : comment.path
    const quoted = comment.lineText.trim().slice(0, MAX_QUOTED)
    const head = quoted ? `\`${where}\` — \`${quoted.replace(/`/g, "'")}\`` : `\`${where}\``
    const body = comment.text
      .trim()
      .split('\n')
      .map((line) => `   ${line}`)
      .join('\n')
    return `${i + 1}. ${head}\n${body}`
  })
  const intro =
    comments.length === 1
      ? 'Please address this review comment on the current changes:'
      : 'Please address these review comments on the current changes:'
  return `${intro}\n\n${items.join('\n\n')}\n`
}

/** A comment placed on a line of the current diff, ready to show or send. */
export interface PlacedComment extends ReviewComment {
  /** `hunk:line` of the diff line it sits under. */
  key: string
  /**
   * The line it was about is not in the diff any more (or pi named a line
   * the diff does not show): it sits on the file's first line instead, and
   * its text starts with the line number.
   */
  fallback: boolean
}

/**
 * Place a project's comments on the diff. Yours follow their line by its
 * text, nearest to where it was; pi's remarks go on the line they name.
 * Comments on files the diff no longer shows are left out.
 */
export function placeComments(
  files: readonly DiffFile[],
  comments: readonly ReviewComment[]
): PlacedComment[] {
  const placed: PlacedComment[] = []
  for (const comment of comments) {
    const file = files.find((f) => f.path === comment.path)
    if (!file) {
      continue
    }
    let found: { key: string; line?: number; lineText: string } | null = null
    if (comment.lineText) {
      let best = Infinity
      file.hunks.forEach((hunk, i) =>
        hunk.lines.forEach((line, j) => {
          if (line.text !== comment.lineText) {
            return
          }
          const no = line.newNo ?? line.oldNo
          const distance = Math.abs((no ?? 0) - (comment.line ?? 0))
          if (distance < best) {
            best = distance
            found = { key: `${i}:${j}`, ...(no !== undefined ? { line: no } : {}), lineText: line.text }
          }
        })
      )
    } else {
      const anchor = anchorForLine(file, comment.line)
      if (anchor?.exact) {
        found = anchor
      }
    }
    if (found) {
      const at = found as { key: string; line?: number; lineText: string }
      const line = at.line ?? comment.line
      placed.push({
        ...comment,
        key: at.key,
        ...(line !== undefined ? { line } : {}),
        lineText: at.lineText,
        fallback: false
      })
      continue
    }
    const first = anchorForLine(file, undefined)
    if (first) {
      placed.push({
        ...comment,
        key: first.key,
        text: comment.line !== undefined ? `Line ${comment.line}: ${comment.text}` : comment.text,
        fallback: true
      })
    }
  }
  return placed
}
