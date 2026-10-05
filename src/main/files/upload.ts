import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MAX_UPLOAD_BYTES } from '../../shared/remote/protocol'

/** A file name safe on every platform, keeping its extension. */
function safeName(name: unknown): string {
  const raw = typeof name === 'string' ? name : ''
  const base = raw.split(/[\\/]/).pop() ?? ''
  const clean = [...base]
    .filter((char) => char.charCodeAt(0) >= 0x20 && !'<>:"|?*'.includes(char))
    .join('')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  return clean || 'file'
}

/** Uploads older than this are gone: pi read them long ago. */
export const UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

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
  // Sized from the text before anything is decoded.
  if (Math.floor((data.length * 3) / 4) - 2 > MAX_UPLOAD_BYTES) {
    throw new Error(`Files up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB can be sent`)
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error('Invalid file data')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0) {
    throw new Error('The file is empty')
  }
  await pruneUploads(root)
  const dir = join(root, randomUUID())
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, safeName(name))
  await writeFile(path, bytes, { mode: 0o600 })
  return { path, size: bytes.length }
}
