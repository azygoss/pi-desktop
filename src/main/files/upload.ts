import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
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
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error('Invalid file data')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0) {
    throw new Error('The file is empty')
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(`Files up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB can be sent`)
  }
  const dir = join(root, randomUUID())
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, safeName(name))
  await writeFile(path, bytes, { mode: 0o600 })
  return { path, size: bytes.length }
}
