import { cp, lstat, mkdir, open, rename, rm, rmdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'

/**
 * Move a file or folder to the user's trash without Electron. Pi Desktop
 * never deletes for good, and the headless host keeps that promise: on Linux
 * this follows the freedesktop.org Trash spec (the home trash, so the file
 * shows up in any desktop's trash can and can be restored with `gio trash
 * --restore` or by hand); on macOS it moves into ~/.Trash.
 */
export async function moveToTrash(
  path: string,
  options: { platform?: NodeJS.Platform; home?: string; dataHome?: string; now?: Date } = {}
): Promise<void> {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const source = resolve(path)
  if (platform === 'darwin') {
    const dir = join(home, '.Trash')
    await mkdir(dir, { recursive: true })
    await moveInto(source, dir, async () => {})
    return
  }
  if (platform === 'win32') {
    throw new Error('Moving to the Recycle Bin is not supported here')
  }
  const root = join(
    options.dataHome ?? process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'),
    'Trash'
  )
  const filesDir = join(root, 'files')
  const infoDir = join(root, 'info')
  await mkdir(filesDir, { recursive: true, mode: 0o700 })
  await mkdir(infoDir, { recursive: true, mode: 0o700 })
  const deletedAt = formatDate(options.now ?? new Date())
  await moveInto(source, filesDir, async (name) => {
    // The info file is created first and exclusively: it reserves the name.
    const info = await open(join(infoDir, `${name}.trashinfo`), 'wx', 0o600)
    try {
      await info.writeFile(
        `[Trash Info]\nPath=${encodeTrashPath(source)}\nDeletionDate=${deletedAt}\n`
      )
    } finally {
      await info.close()
    }
    return () => unlink(join(infoDir, `${name}.trashinfo`)).catch(() => {})
  })
}

/**
 * Move `source` into `dir` under a free name. `reserve` claims a name (and
 * may return an undo); an existing name moves on to "name 2", "name 3", …
 */
async function moveInto(
  source: string,
  dir: string,
  reserve: (name: string) => Promise<(() => Promise<void>) | void>
): Promise<void> {
  const base = basename(source)
  const ext = extname(base)
  const stem = ext && ext !== base ? base.slice(0, -ext.length) : base
  for (let attempt = 1; attempt <= 1000; attempt++) {
    const name = attempt === 1 ? base : `${stem} ${attempt}${ext}`
    let undo: (() => Promise<void>) | void
    try {
      undo = await reserve(name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue
      }
      throw error
    }
    const target = join(dir, name)
    try {
      await moveNoClobber(source, target)
      return
    } catch (error) {
      await undo?.()
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue
      }
      throw error
    }
  }
  throw new Error('No free name in the trash')
}

async function moveNoClobber(source: string, target: string): Promise<void> {
  // rename() replaces what is at the target; claim the name first with an
  // empty placeholder of the same kind, which rename() may replace.
  const isDir = (await lstat(source)).isDirectory()
  if (isDir) {
    await mkdir(target)
  } else {
    await (await open(target, 'wx')).close()
  }
  const release = () => (isDir ? rmdir(target) : unlink(target)).catch(() => {})
  try {
    await rename(source, target)
  } catch (error) {
    await release()
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw error
    }
    // Another filesystem: copy across, then drop the original.
    await cp(source, target, { recursive: true, errorOnExist: true, force: false })
    await rm(source, { recursive: true, force: true })
  }
}

function encodeTrashPath(path: string): string {
  return path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}
