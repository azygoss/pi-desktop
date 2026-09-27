import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'
import type { ImageContent } from '../../shared/pi-types'
import { getSessionsDir } from '../sessions/paths'

const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_MESSAGE_LENGTH = 200_000
const MAX_IMAGES_TOTAL_BYTES = 20 * 1024 * 1024
const MAX_IMAGES = 16
const BASE64_PATTERN = /^[A-Za-z0-9+/=\s]+$/

export function validateChatId(value: unknown): string {
  if (typeof value !== 'string' || !CHAT_ID_PATTERN.test(value)) {
    throw new Error('Invalid chatId: expected a string of up to 64 [A-Za-z0-9_-] characters')
  }
  return value
}

export function validateMessage(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MESSAGE_LENGTH) {
    throw new Error('Invalid message: expected a non-empty string under 200k characters')
  }
  return value
}

/** cwd must be an absolute path to an existing directory; defaults to home. */
export async function validateCwd(value: unknown): Promise<string> {
  if (value === undefined || value === null || value === '') {
    return homedir()
  }
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error('Invalid cwd: expected an absolute path')
  }
  const resolved = resolve(value)
  try {
    const s = await stat(resolved)
    if (!s.isDirectory()) {
      throw new Error('Invalid cwd: not a directory')
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid cwd')) {
      throw error
    }
    throw new Error('Invalid cwd: directory does not exist', { cause: error })
  }
  return resolved
}

/** sessionPath must resolve to a .jsonl file inside the sessions directory. */
export function validateSessionPath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || !value.endsWith('.jsonl')) {
    throw new Error('Invalid sessionPath: expected an absolute .jsonl path')
  }
  const sessionsDir = resolve(getSessionsDir())
  const resolved = resolve(value)
  if (resolved !== sessionsDir && !resolved.startsWith(sessionsDir + sep)) {
    throw new Error('Invalid sessionPath: must live inside the pi sessions directory')
  }
  return resolved
}

export function validateImages(value: unknown): ImageContent[] | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (!Array.isArray(value) || value.length > MAX_IMAGES) {
    throw new Error(`Invalid images: expected an array of up to ${MAX_IMAGES} items`)
  }
  if (value.length === 0) {
    return undefined
  }
  let totalBytes = 0
  const images: ImageContent[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') {
      throw new Error('Invalid image entry')
    }
    const { data, mimeType } = item as { data?: unknown; mimeType?: unknown }
    if (typeof mimeType !== 'string' || !ALLOWED_IMAGE_TYPES.has(mimeType)) {
      throw new Error('Invalid image: mimeType must be image/png, jpeg, gif or webp')
    }
    if (typeof data !== 'string' || data.length === 0 || !BASE64_PATTERN.test(data)) {
      throw new Error('Invalid image: data must be base64')
    }
    totalBytes += Math.ceil((data.length / 4) * 3)
    if (totalBytes > MAX_IMAGES_TOTAL_BYTES) {
      throw new Error('Invalid images: total size exceeds 20MB')
    }
    images.push({ type: 'image', data, mimeType })
  }
  return images
}

export function requireString(value: unknown, field: string, maxLength = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Invalid ${field}`)
  }
  return value
}
