import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { getSessionsDir } from './paths'

/**
 * Encode a cwd the way pi names session directories (session-format.md):
 * strip the leading separator, replace `/`, `\` and `:` with `-`, wrap in
 * `--...--`.
 */
export function sessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]+/, '').replaceAll(/[/\\:]/g, '-')}--`
}

/**
 * Copy an external .jsonl session file into pi's session storage under the
 * directory matching its recorded cwd. Never overwrites: a `-1`, `-2`, …
 * suffix is appended to the file name when it already exists.
 */
export async function importSessionFile(sourcePath: string): Promise<{ sessionPath: string }> {
  const sourceStat = await stat(sourcePath)
  if (!sourceStat.isFile() || !sourcePath.endsWith('.jsonl')) {
    throw new Error('Not a .jsonl session file')
  }
  const head = await readFile(sourcePath, { encoding: 'utf8' })
  const firstLine = head.split('\n', 1)[0] ?? ''
  let cwd = ''
  try {
    const header = JSON.parse(firstLine) as Record<string, unknown>
    if (header['type'] === 'session' && typeof header['cwd'] === 'string') {
      cwd = header['cwd']
    }
  } catch {
    // fall through — an unreadable header imports under a neutral bucket
  }
  if (!cwd) {
    throw new Error('File does not look like a pi session (missing header cwd)')
  }

  const targetDir = join(getSessionsDir(), sessionDirName(cwd))
  await mkdir(targetDir, { recursive: true })

  const stem = basename(sourcePath, '.jsonl')
  for (let i = 0; ; i++) {
    const name = i === 0 ? `${stem}.jsonl` : `${stem}-${i}.jsonl`
    const target = join(targetDir, name)
    try {
      await copyFile(sourcePath, target, constants.COPYFILE_EXCL)
      return { sessionPath: target }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue
      }
      throw error
    }
  }
}
