import { describe, expect, it } from 'vitest'

import {
  countChanges,
  diffFileForUntracked,
  parsePorcelainStatus,
  parseUnifiedDiff,
  unquoteGitPath
} from './diff-parse'

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line one
-old line
+new line
+another
 end
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old-name.ts b/new-name.ts
similarity index 90%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1 +1 @@
-x
+y
diff --git a/bin.png b/bin.png
Binary files a/bin.png and b/bin.png differ
`

describe('parseUnifiedDiff', () => {
  it('parses files, statuses and hunks', () => {
    const files = parseUnifiedDiff(SAMPLE)
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['new.ts', 'added'],
      ['gone.ts', 'deleted'],
      ['new-name.ts', 'renamed'],
      ['bin.png', 'modified']
    ])
    expect(files[4]!.isBinary).toBe(true)
    expect(files[3]!.oldPath).toBe('old-name.ts')
  })

  it('tracks line numbers per hunk', () => {
    const [file] = parseUnifiedDiff(SAMPLE)
    const hunk = file!.hunks[0]!
    expect(hunk.lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ['ctx', 1, 1],
      ['del', 2, undefined],
      ['add', undefined, 2],
      ['add', undefined, 3],
      ['ctx', 3, 4]
    ])
  })

  it('handles empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    expect(parseUnifiedDiff('noise\nmore\n')).toEqual([])
  })

  it('marks a pure rename (no ---/+++ lines) as renamed', () => {
    const files = parseUnifiedDiff(`diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'new.ts', oldPath: 'old.ts', status: 'renamed', hunks: [] })
  })

  it('unquotes C-quoted ---/+++ paths (octal UTF-8, escapes)', () => {
    const files = parseUnifiedDiff(`diff --git "a/yeni dosya \\360\\237\\232\\200.txt" "b/yeni dosya \\360\\237\\232\\200.txt"
index 111..222 100644
--- "a/yeni dosya \\360\\237\\232\\200.txt"
+++ "b/yeni dosya \\360\\237\\232\\200.txt"
@@ -1 +1 @@
-x
+y
diff --git "a/tricky \\"quote\\" \\t.txt" "b/tricky \\"quote\\" \\t.txt"
--- "a/tricky \\"quote\\" \\t.txt"
+++ "b/tricky \\"quote\\" \\t.txt"
@@ -1 +1 @@
-p
+q
`)
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['yeni dosya 🚀.txt', 'modified'],
      ['tricky "quote" \t.txt', 'modified']
    ])
  })

  it('unquotes the diff --git header fallback (binary quoted path)', () => {
    const files = parseUnifiedDiff(`diff --git "a/t\\304\\237rk.png" "b/t\\304\\237rk.png"
Binary files "a/t\\304\\237rk.png" and "b/t\\304\\237rk.png" differ
`)
    expect(files[0]).toMatchObject({ path: 'tğrk.png', status: 'modified', isBinary: true })
  })

  it('unquotes rename from/to lines', () => {
    const files = parseUnifiedDiff(`diff --git "a/\\304\\237eski.ts" "b/\\304\\237yeni.ts"
similarity index 100%
rename from "\\304\\237eski.ts"
rename to "\\304\\237yeni.ts"
`)
    expect(files[0]).toMatchObject({ path: 'ğyeni.ts', oldPath: 'ğeski.ts', status: 'renamed' })
  })
})

describe('unquoteGitPath', () => {
  it('returns unquoted strings unchanged', () => {
    expect(unquoteGitPath('a/plain.ts')).toBe('a/plain.ts')
    expect(unquoteGitPath('plain.ts')).toBe('plain.ts')
  })

  it('decodes octal UTF-8 byte escapes', () => {
    expect(unquoteGitPath('"a/yeni dosya \\360\\237\\232\\200.txt"')).toBe('a/yeni dosya 🚀.txt')
    expect(unquoteGitPath('"t\\304\\237rk.ts"')).toBe('tğrk.ts')
  })

  it('decodes the simple escapes', () => {
    expect(unquoteGitPath('"q\\"t\\"\\t\\\\x"')).toBe('q"t"\t\\x')
  })

  it('keeps the raw string on undecodable bytes', () => {
    expect(unquoteGitPath('"\\377\\377"')).toBe('"\\377\\377"')
  })
})

describe('parsePorcelainStatus', () => {
  it('parses -z separated entries including renames', () => {
    const text = ' M src/a.ts\0?? new.ts\0R  new.ts\0old.ts\0'
    expect(parsePorcelainStatus(text)).toEqual([
      { status: ' M', path: 'src/a.ts' },
      { status: '??', path: 'new.ts' },
      { status: 'R ', path: 'new.ts' }
    ])
  })
})

describe('diffFileForUntracked', () => {
  it('turns file contents into an all-added hunk', () => {
    const file = diffFileForUntracked('fresh.ts', 'a\nb\n')
    expect(file.status).toBe('added')
    expect(countChanges(file)).toEqual({ added: 2, deleted: 0 })
    expect(file.hunks[0]!.lines.map((l) => l.text)).toEqual(['a', 'b'])
  })

  it('flags binary and oversized files instead of a hunk', () => {
    const binary = diffFileForUntracked('blob.bin', '', { binary: true })
    expect(binary).toMatchObject({ status: 'added', hunks: [], isBinary: true })
    const large = diffFileForUntracked('huge.log', '', { tooLarge: true })
    expect(large).toMatchObject({ status: 'added', hunks: [], tooLarge: true })
  })
})
