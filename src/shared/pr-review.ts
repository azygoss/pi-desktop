/**
 * Turning a project's diff comments into one GitHub pull request review.
 * Pure: the main process fetches the PR's files and posts the result.
 */

/** The name diff comments are signed with on GitHub. */
export const PR_COMMENT_SIGNATURE = 'pi-bot'

/** Most comments one review takes: as many as a project keeps. */
export const MAX_PR_COMMENTS = 200

export interface PrCommentInput {
  path: string
  /** Line in the new file, when known. */
  line?: number
  /** The line's text as the diff showed it ('' when unknown). */
  lineText: string
  text: string
  author?: 'pi'
  /**
   * The comment is on a removed line (`line` is then the old file's): never
   * put on a line of the new file, it is listed in the review's body.
   */
  removed?: boolean
}

/** A file of the pull request as GitHub's `pulls/{n}/files` lists it. */
export interface PrFile {
  filename: string
  /** Unified diff hunks; missing for binary or very large files. */
  patch?: string
}

export interface PrReviewDraft {
  body: string
  comments: { path: string; line: number; side: 'RIGHT'; body: string }[]
}

/**
 * The lines a review comment can sit on in one file's patch: the new
 * file's added and context lines, by line number.
 */
export function rightSideLines(patch: string): Map<number, string> {
  const lines = new Map<number, string>()
  let next = 0
  for (const raw of patch.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      next = Number(hunk[1])
      continue
    }
    if (next === 0) {
      continue
    }
    if (line.startsWith('+') || line.startsWith(' ')) {
      lines.set(next, line.slice(1))
      next += 1
    }
    // '-' lines and "\ No newline at end of file" do not move the new side.
  }
  return lines
}

function signed(comment: PrCommentInput): string {
  const by = comment.author === 'pi' ? `${PR_COMMENT_SIGNATURE} · pi's review` : PR_COMMENT_SIGNATURE
  return `${comment.text.trim()}\n\n<sub>${by}</sub>`
}

function quote(text: string): string {
  return text.replace(/`/g, "'").slice(0, 120)
}

/**
 * One review for the comments: a comment whose line is in the pull request,
 * with the same text, goes on that line; the rest (lines only changed
 * locally, not pushed yet) are listed in the review's body.
 */
export function buildPrReview(
  comments: readonly PrCommentInput[],
  files: readonly PrFile[]
): PrReviewDraft {
  const byPath = new Map<string, Map<number, string>>()
  for (const file of files) {
    if (file.patch) {
      byPath.set(file.filename, rightSideLines(file.patch))
    }
  }
  const inline: PrReviewDraft['comments'] = []
  const listed: string[] = []
  for (const comment of comments.slice(0, MAX_PR_COMMENTS)) {
    const lines = byPath.get(comment.path)
    const onLine =
      !comment.removed &&
      comment.line !== undefined &&
      lines?.has(comment.line) &&
      (comment.lineText === '' || lines.get(comment.line) === comment.lineText)
    if (onLine) {
      inline.push({ path: comment.path, line: comment.line!, side: 'RIGHT', body: signed(comment) })
      continue
    }
    const where = comment.line !== undefined ? `${comment.path}:${comment.line}` : comment.path
    const about = comment.lineText.trim() ? ` — \`${quote(comment.lineText.trim())}\`` : ''
    const by = `${comment.removed ? ' _(removed line)_' : ''}${comment.author === 'pi' ? ' _(pi)_' : ''}`
    const text = comment.text.trim().split('\n').join('\n  ')
    listed.push(`- \`${where}\`${about}${by}\n  ${text}`)
  }
  const count = Math.min(comments.length, MAX_PR_COMMENTS)
  const head = `**${PR_COMMENT_SIGNATURE}** · ${count} review ${count === 1 ? 'comment' : 'comments'} from Pi Desktop`
  const body =
    listed.length === 0
      ? head
      : `${head}\n\nOn lines that are not in this pull request yet (uncommitted or not pushed):\n\n${listed.join('\n')}`
  return { body, comments: inline }
}
