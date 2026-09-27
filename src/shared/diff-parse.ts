/**
 * Pure parsers for `git diff` (unified format) and `git status --porcelain`.
 * Shared between main (no node deps here) and renderer.
 */

export interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  /** The @@ … @@ header line, unparsed. */
  header: string
  lines: DiffLine[]
}

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed'

export interface DiffFile {
  /** Display path (new path for renames). */
  path: string
  oldPath?: string
  status: DiffFileStatus
  hunks: DiffHunk[]
  isBinary?: boolean
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '')
}

/** Parse unified `git diff` output into per-file hunks. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let oldPath: string | undefined
  let newPath: string | undefined
  /** Fallback display path parsed from the `diff --git` line itself. */
  let headerPath = ''

  const flush = (): void => {
    if (file) {
      const np = newPath && newPath !== '/dev/null' ? stripPrefix(newPath) : undefined
      const op = oldPath && oldPath !== '/dev/null' ? stripPrefix(oldPath) : undefined
      file.path = np ?? op ?? headerPath
      file.oldPath = op && op !== file.path ? op : undefined
      if (file.status === 'modified' && file.oldPath) {
        file.status = 'renamed'
      }
      files.push(file)
    }
    file = null
    hunk = null
    oldPath = undefined
    newPath = undefined
    headerPath = ''
  }

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      // `diff --git a/old b/new` — the b/ path is the display fallback for
      // files without ---/+++ lines (e.g. binary).
      const header = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line)
      headerPath = header?.[2] ?? ''
      file = { path: headerPath, status: 'modified', hunks: [] }
      continue
    }
    if (!file) {
      continue
    }
    if (line.startsWith('new file mode')) {
      file.status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'deleted'
      continue
    }
    if (line.startsWith('Binary files')) {
      file.isBinary = true
      continue
    }
    if (line.startsWith('--- ')) {
      oldPath = line.slice(4).trim()
      if (oldPath === '/dev/null') {
        file.status = 'added'
      }
      continue
    }
    if (line.startsWith('+++ ')) {
      newPath = line.slice(4).trim()
      if (newPath === '/dev/null') {
        file.status = 'deleted'
      }
      continue
    }
    const hunkMatch = HUNK_RE.exec(line)
    if (hunkMatch) {
      oldNo = Number(hunkMatch[1])
      newNo = Number(hunkMatch[2])
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) {
      continue
    }
    const ch = line[0]
    if (ch === '+') {
      hunk.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ })
    } else if (ch === '-') {
      hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ })
    } else if (ch === ' ') {
      hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
    // '\' (no newline marker) and anything else is skipped
  }
  flush()
  return files
}

/** Parse `git status --porcelain=v1 -z` output into path entries. */
export function parsePorcelainStatus(text: string): { status: string; path: string }[] {
  const entries: { status: string; path: string }[] = []
  const parts = text.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    if (entry.length < 4) {
      continue
    }
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    // Renames/copies store "new\0orig" — the entry path is the new name and
    // the following NUL-separated part is the original; skip it.
    if (status.includes('R') || status.includes('C')) {
      i++
    }
    entries.push({ status, path })
  }
  return entries
}

/** Build a synthetic all-added DiffFile for an untracked file's contents. */
export function diffFileForUntracked(path: string, content: string): DiffFile {
  const lines = content.split('\n')
  // A trailing newline produces a final empty line — drop it.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return {
    path,
    status: 'added',
    hunks: [
      {
        header: `@@ -0,0 +1,${lines.length} @@`,
        lines: lines.map((text, i) => ({ type: 'add' as const, text, newNo: i + 1 }))
      }
    ]
  }
}

export function countChanges(file: DiffFile): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') {
        added++
      } else if (line.type === 'del') {
        deleted++
      }
    }
  }
  return { added, deleted }
}
