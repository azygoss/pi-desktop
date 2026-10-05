import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MAX_UPLOAD_BYTES } from '../../shared/remote/protocol'

/** A file name safe on every platform, keeping its extension. */
function safeName(name: unknown): string {
  const raw = typeof name === 'string' ? name : ''
  const base = raw.split(/[\\/]/).pop() ?? ''
  let clean = [...base]
    .filter((char) => char.charCodeAt(0) >= 0x20 && !'<>:"|?*'.includes(char))
    .join('')
    .replace(/^\.+/, '')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120)
  // Device names Windows will not store as files (a host may run there).
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(clean)) {
    clean = `_${clean}`
  }
  return clean || 'file'
}

/**
 * Uploads older than this are removed. A chat that comes back to a file
 * after that sees it gone (the phone still has the original); a month keeps
 * the files of any chat that is still being worked on.
 */
export const UPLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Drop upload folders older than the retention period. They are the app's
 * own copies of files from the phone (the originals stay on the phone).
 */
export async function pruneUploads(root: string, now = Date.now()): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) {
      continue
    }
    const dir = join(root, entry.name)
    const info = await stat(dir).catch(() => null)
    if (info && now - info.mtimeMs > UPLOAD_RETENTION_MS) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/**
 * Store a file a paired phone sent (a document, a log, a photo) under the
 * app's data directory, in a folder of its own so names never clash, and
 * return its path for pi to read. Uploads never land in a project.
 */
export async function saveUpload(
  root: string,
  name: unknown,
  data: unknown
): Promise<{ path: string; size: number }> {
  if (typeof data !== 'string') {
    throw new Error('Invalid file data')
  }
  // Sized from the text before anything is decoded (exact for valid base64).
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  if (Math.floor((data.length * 3) / 4) - padding > MAX_UPLOAD_BYTES) {
    throw new Error(`Files up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB can be sent`)
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error('Invalid file data')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0) {
    throw new Error('The file is empty')
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(`Files up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB can be sent`)
  }
  await pruneUploads(root)
  const dir = join(root, randomUUID())
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, safeName(name))
  await writeFile(path, bytes, { mode: 0o600 })
  return { path, size: bytes.length }
}
