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
  /** Untracked file too large to inline; rendered with a label only. */
  tooLarge?: boolean
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '')
}

const QUOTED_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  '\\': 0x5c
}

/**
 * Undo git's C-style quoting of paths containing non-ASCII or unusual
 * bytes (`"a/yeni dosya \360\237\232\200.txt"` when core.quotepath is on):
 * unescape the simple escapes and 3-digit octal byte escapes, then decode
 * the bytes as UTF-8 — byte by byte via %XX + decodeURIComponent, no
 * TextDecoder (this module also runs on React Native). Returns `s`
 * unchanged when it is not quoted or the bytes are not valid UTF-8.
 */
export function unquoteGitPath(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) {
    return s
  }
  const body = s.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch !== '\\') {
      if (ch.codePointAt(0)! > 0xff) {
        return s
      }
      bytes.push(ch.charCodeAt(0))
      continue
    }
    const next = body[i + 1]
    if (next === undefined) {
      return s
    }
    if (next >= '0' && next <= '7') {
      let octal = ''
      while (i + 1 < body.length && octal.length < 3 && /[0-7]/.test(body[i + 1]!)) {
        octal += body[++i]
      }
      bytes.push(parseInt(octal, 8))
      continue
    }
    i++
    const simple = QUOTED_ESCAPES[next]
    if (simple !== undefined) {
      bytes.push(simple)
    } else if (next.codePointAt(0)! <= 0xff) {
      bytes.push(next.charCodeAt(0))
    } else {
      return s
    }
  }
  try {
    return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''))
  } catch {
    // Not valid UTF-8 — keep the quoted form as-is.
    return s
  }
}

/** One `diff --git` side token: C-quoted string or text up to a space. */
function readHeaderToken(text: string): { token: string; rest: string } | undefined {
  if (text.startsWith('"')) {
    for (let i = 1; i < text.length; i++) {
      if (text[i] === '\\') {
        i++
      } else if (text[i] === '"') {
        return { token: text.slice(0, i + 1), rest: text.slice(i + 1) }
      }
    }
    return undefined
  }
  const space = text.indexOf(' ')
  return space === -1
    ? { token: text, rest: '' }
    : { token: text.slice(0, space), rest: text.slice(space) }
}

/** The b/ path of a `diff --git` line; C-quoted sides are unquoted. */
function headerNewPath(line: string): string {
  const tail = line.slice('diff --git '.length)
  if (!tail.includes('"')) {
    // Unquoted header — keep the previous parse, which tolerated spaces in
    // the a/ side by letting the b/ side take the last " b/" boundary.
    return /^a\/(.+?) b\/(.+?)$/.exec(tail)?.[2] ?? ''
  }
  const a = readHeaderToken(tail)
  const b = a ? readHeaderToken(a.rest.trimStart()) : undefined
  if (!b) {
    return ''
  }
  return stripPrefix(unquoteGitPath(b.token))
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
  /** ---/+++ paths carry a/ b/ prefixes; `rename from`/`to` do not. */
  let oldPrefixed = false
  let newPrefixed = false
  /** Fallback display path parsed from the `diff --git` line itself. */
  let headerPath = ''

  const flush = (): void => {
    if (file) {
      const np =
        newPath && newPath !== '/dev/null'
          ? newPrefixed
            ? stripPrefix(newPath)
            : newPath
          : undefined
      const op =
        oldPath && oldPath !== '/dev/null'
          ? oldPrefixed
            ? stripPrefix(oldPath)
            : oldPath
          : undefined
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
    oldPrefixed = false
    newPrefixed = false
    headerPath = ''
  }

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      // `diff --git a/old b/new` — the b/ path is the display fallback for
      // files without ---/+++ lines (e.g. binary, pure renames).
      headerPath = headerNewPath(line)
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
    // Pure renames (100% similarity) carry only rename from/to lines.
    if (line.startsWith('rename from ')) {
      oldPath = unquoteGitPath(line.slice('rename from '.length).trim())
      oldPrefixed = false
      continue
    }
    if (line.startsWith('rename to ')) {
      newPath = unquoteGitPath(line.slice('rename to '.length).trim())
      newPrefixed = false
      continue
    }
    if (line.startsWith('--- ')) {
      oldPath = unquoteGitPath(line.slice(4).trim())
      oldPrefixed = true
      if (oldPath === '/dev/null') {
        file.status = 'added'
      }
      continue
    }
    if (line.startsWith('+++ ')) {
      newPath = unquoteGitPath(line.slice(4).trim())
      newPrefixed = true
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

/**
 * Build a synthetic all-added DiffFile for an untracked file's contents.
 * Binary and oversized files have no content to show — `flags` marks them
 * so the panel can say so instead of rendering an empty diff.
 */
export function diffFileForUntracked(
  path: string,
  content: string,
  flags?: { binary?: boolean; tooLarge?: boolean }
): DiffFile {
  if (flags?.binary) {
    return { path, status: 'added', hunks: [], isBinary: true }
  }
  if (flags?.tooLarge) {
    return { path, status: 'added', hunks: [], tooLarge: true }
  }
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
