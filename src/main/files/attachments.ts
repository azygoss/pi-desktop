import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'

/**
 * Read picker/drop file paths into composer attachments. Small images become
 * inline base64 payloads (same shape as the drag&drop File path); everything
 * else stays a path reference the composer renders as a file chip.
 */

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_FILES = 16

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

export type AttachmentReadResult =
  | { kind: 'image'; path: string; name: string; size: number; mimeType: string; data: string }
  | { kind: 'file'; path: string; name: string; size: number }

export async function readAttachments(paths: string[]): Promise<AttachmentReadResult[]> {
  const out: AttachmentReadResult[] = []
  for (const raw of paths.slice(0, MAX_FILES)) {
    if (typeof raw !== 'string' || !isAbsolute(raw)) {
      continue
    }
    const info = await stat(raw).catch(() => null)
    if (!info?.isFile()) {
      continue
    }
    const name = basename(raw)
    const mimeType = IMAGE_MIME[extname(name).toLowerCase()]
    if (mimeType && info.size <= MAX_IMAGE_BYTES) {
      const data = await readFile(raw).catch(() => null)
      if (data) {
        out.push({
          kind: 'image',
          path: raw,
          name,
          size: info.size,
          mimeType,
          data: data.toString('base64')
        })
        continue
      }
    }
    out.push({ kind: 'file', path: raw, name, size: info.size })
  }
  return out
}
