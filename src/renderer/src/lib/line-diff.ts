/**
 * Line diff for edit steps: the old and new text of a replacement, merged
 * into one unified view (context, removed, added) the way a reviewer reads
 * it, instead of a block of old lines above a block of new ones.
 */

export interface DiffLine {
  kind: 'context' | 'removed' | 'added'
  text: string
}

/** Above this many cells the LCS table is skipped for a plain old→new split. */
const MAX_LCS_CELLS = 400_000

function splitLines(text: string): string[] {
  return text.length > 0 ? text.replace(/\n$/, '').split('\n') : []
}

/** Longest-common-subsequence diff of two line arrays (no shared ends). */
function diffMiddle(a: string[], b: string[]): DiffLine[] {
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_LCS_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'removed', text })),
      ...b.map((text): DiffLine => ({ kind: 'added', text }))
    ]
  }
  const width = b.length + 1
  // table[i * width + j] = LCS length of a[i:] and b[j:]
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i]! })
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      out.push({ kind: 'removed', text: a[i]! })
      i += 1
    } else {
      out.push({ kind: 'added', text: b[j]! })
      j += 1
    }
  }
  while (i < a.length) {
    out.push({ kind: 'removed', text: a[i++]! })
  }
  while (j < b.length) {
    out.push({ kind: 'added', text: b[j++]! })
  }
  return out
}

/** Unified line diff of `oldText` → `newText`. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  let lead = 0
  while (lead < a.length && lead < b.length && a[lead] === b[lead]) {
    lead += 1
  }
  let trail = 0
  while (
    trail < a.length - lead &&
    trail < b.length - lead &&
    a[a.length - 1 - trail] === b[b.length - 1 - trail]
  ) {
    trail += 1
  }
  const context = (lines: string[]): DiffLine[] =>
    lines.map((text) => ({ kind: 'context', text }))
  return [
    ...context(a.slice(0, lead)),
    ...diffMiddle(a.slice(lead, a.length - trail), b.slice(lead, b.length - trail)),
    ...context(a.slice(a.length - trail))
  ]
}

/**
 * Keep `radius` context lines around each change; longer unchanged runs
 * collapse into a `null` gap marker.
 */
export function trimContext(lines: DiffLine[], radius = 3): (DiffLine | null)[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.kind === 'context') {
      return
    }
    for (let k = Math.max(0, index - radius); k <= Math.min(lines.length - 1, index + radius); k++) {
      keep[k] = true
    }
  })
  const out: (DiffLine | null)[] = []
  lines.forEach((line, index) => {
    if (keep[index]) {
      out.push(line)
    } else if (out.length > 0 && out[out.length - 1] !== null) {
      out.push(null)
    }
  })
  while (out.length > 0 && out[out.length - 1] === null) {
    out.pop()
  }
  return out
}
