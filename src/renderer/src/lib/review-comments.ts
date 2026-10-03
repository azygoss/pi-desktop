/** A note left on one line of the working-tree diff. */
export interface ReviewComment {
  id: string
  path: string
  /** Line number in the new file (old file for removed lines). */
  line?: number
  /** The line the comment is about, as shown in the diff. */
  lineText: string
  text: string
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
