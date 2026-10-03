import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { FileReadResult } from '../../shared/api'

/** Larger files are cut off; the viewer says so. */
export const MAX_VIEW_BYTES = 512 * 1024

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Read a text file for the panel's file viewer. The file must live inside
 * the project folder (symlinks resolved) and outside `denyDirs` — the pi
 * agent dir holds credentials the app must never read.
 */
export async function readProjectFile(
  cwd: string,
  path: unknown,
  denyDirs: string[] = []
): Promise<FileReadResult> {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
    throw new Error('Invalid path')
  }
  const requested = isAbsolute(path) ? resolve(path) : resolve(join(cwd, path))
  const [root, real] = await Promise.all([realpath(cwd), realpath(requested)])
  if (!inside(root, real)) {
    throw new Error('That file is outside the project folder')
  }
  for (const dir of denyDirs) {
    const deny = await realpath(dir).catch(() => resolve(dir))
    if (inside(deny, real)) {
      throw new Error('That file cannot be opened here')
    }
  }
  const info = await stat(real)
  if (!info.isFile()) {
    throw new Error('Not a file')
  }
  const handle = await open(real, 'r')
  try {
    const length = Math.min(info.size, MAX_VIEW_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    const binary = buffer.subarray(0, 8192).includes(0)
    return {
      path: real,
      relativePath: relative(root, real).split(sep).join('/'),
      size: info.size,
      binary,
      truncated: info.size > MAX_VIEW_BYTES,
      content: binary ? '' : buffer.toString('utf8')
    }
  } finally {
    await handle.close()
  }
}
