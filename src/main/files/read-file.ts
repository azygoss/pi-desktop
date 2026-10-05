import { open, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { FileReadResult } from '../../shared/api'
import { MAX_REMOTE_IMAGE_BYTES } from '../../shared/remote/protocol'

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
/** The real path of a file inside the project, refusing everything else. */
async function resolveProjectFile(
  cwd: string,
  path: unknown,
  denyDirs: string[]
): Promise<{ root: string; real: string; size: number }> {
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
  return { root, real, size: info.size }
}

/** The image type from a file's first bytes (the extension can lie). */
export function sniffImageType(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === 'PNG') {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6 && ascii(0, 4) === 'GIF8') {
    return 'image/gif'
  }
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

/** An image file inside the project as base64, for a phone's file viewer. */
export async function readProjectImage(
  cwd: string,
  path: unknown,
  denyDirs: string[] = []
): Promise<{ mimeType: string; data: string; size: number }> {
  const { real, size } = await resolveProjectFile(cwd, path, denyDirs)
  if (size > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error('That image is too large to send to the phone')
  }
  const bytes = await readFile(real)
  const mimeType = sniffImageType(bytes)
  if (!mimeType) {
    throw new Error('Not an image this viewer can show')
  }
  return { mimeType, data: bytes.toString('base64'), size }
}

export async function readProjectFile(
  cwd: string,
  path: unknown,
  denyDirs: string[] = []
): Promise<FileReadResult> {
  const { root, real, size } = await resolveProjectFile(cwd, path, denyDirs)
  const info = { size }
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
