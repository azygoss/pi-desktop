import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type { RemoteDirListing } from '../../shared/remote/protocol'

const MAX_DIRS = 400

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Sub-directories of a folder, for choosing a project from a paired phone
 * (which has no native folder dialog to this computer). Names only; hidden
 * folders are left out and `forbidden` roots (the pi agent dir) are never
 * listed.
 */
export async function listDirs(value: unknown, forbidden: string[] = []): Promise<RemoteDirListing> {
  if (value !== undefined && value !== null && value !== '' && typeof value !== 'string') {
    throw new Error('Invalid path')
  }
  const path = typeof value === 'string' && value !== '' ? value : homedir()
  if (!isAbsolute(path) || path.length > 4096) {
    throw new Error('Invalid path')
  }
  const resolved = resolve(path)
  if (forbidden.some((root) => isInside(resolve(root), resolved))) {
    throw new Error('That folder cannot be opened')
  }
  let entries
  try {
    entries = await readdir(resolved, { withFileTypes: true })
  } catch {
    throw new Error('That folder cannot be opened')
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_DIRS)
  const repo = await stat(join(resolved, '.git')).then(
    () => true,
    () => false
  )
  const parent = dirname(resolved)
  return { path: resolved, parent: parent === resolved ? null : parent, dirs, repo }
}
