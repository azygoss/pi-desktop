/**
 * Split markdown into top-level chunks that render identically on their own,
 * so a streaming message re-parses only its last (growing) chunk — earlier
 * chunks keep the same string and hit the memo.
 *
 * A chunk boundary is a non-blank, non-indented line after a blank line,
 * outside a fenced code block, that does not start a list item (so loose
 * lists stay one list). Constructs whose meaning spans blank lines — link
 * reference definitions, footnotes and raw HTML blocks — disable splitting.
 */

const UNSPLITTABLE = /^ {0,3}\[[^\]]+\]:|<(?:pre|script|style|textarea)\b|<!--/im
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/

export function splitMarkdownBlocks(text: string): string[] {
  if (UNSPLITTABLE.test(text)) {
    return [text]
  }
  const lines = text.split('\n')
  const chunks: string[] = []
  let start = 0
  let fence: { char: string; length: number } | null = null
  let prevBlank = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (fence) {
      const close = FENCE_CLOSE.exec(line)
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) {
        fence = null
      }
      prevBlank = false
      continue
    }
    const blank = line.trim() === ''
    if (!blank && prevBlank && i > start && /^\S/.test(line) && !LIST_ITEM.test(line)) {
      chunks.push(lines.slice(start, i).join('\n'))
      start = i
    }
    const open = FENCE_OPEN.exec(line)
    if (open) {
      fence = { char: open[1]![0]!, length: open[1]!.length }
    }
    prevBlank = blank
  }
  chunks.push(lines.slice(start).join('\n'))
  return chunks
}
