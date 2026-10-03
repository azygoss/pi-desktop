import type { DiffFile } from '../../../shared/diff-parse'

/** A note left on one line of the working-tree diff. */
export interface ReviewComment {
  id: string
  path: string
  /** Line number in the new file (old file for removed lines). */
  line?: number
  /** The line the comment is about, as shown in the diff. */
  lineText: string
  text: string
  /** Set on remarks pi left in a review pass; yours have none. */
  author?: 'pi'
}

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
export function reviewPrompt(comments: readonly ReviewComment[]): string {
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
