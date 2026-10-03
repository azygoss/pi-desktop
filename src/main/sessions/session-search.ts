import { createReadStream } from 'node:fs'

import type { SessionSearchHit } from '../../shared/api'
import { createJsonlReader } from '../pi/jsonl'

const MAX_CONCURRENT = 8
const SNIPPET_BEFORE = 40
const SNIPPET_AFTER = 110
export const SEARCH_MIN_QUERY = 3

/** Text a person wrote or read: user prompts and assistant prose. */
function messageText(message: unknown): { role: 'user' | 'assistant'; text: string } | null {
  if (message === null || typeof message !== 'object') {
    return null
  }
  const m = message as { role?: unknown; content?: unknown }
  if (m.role !== 'user' && m.role !== 'assistant') {
    return null
  }
  if (typeof m.content === 'string') {
    return { role: m.role, text: m.content }
  }
  if (!Array.isArray(m.content)) {
    return null
  }
  const parts: string[] = []
  for (const block of m.content as { type?: unknown; text?: unknown }[]) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.length > 0 ? { role: m.role, text: parts.join('\n') } : null
}

/** A one-line excerpt around the first match. */
export function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_BEFORE)
  const end = Math.min(text.length, at + length + SNIPPET_AFTER)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/**
 * Scan one session file for `needle` (already lower-cased). Lines are
 * pre-filtered on the raw JSON text so only matching entries are parsed.
 */
function searchFile(
  filePath: string,
  needle: string,
  isCurrent: () => boolean
): Promise<SessionSearchHit | null> {
  // The same text as it appears inside a JSON string (quotes, backslashes).
  const rawNeedle = JSON.stringify(needle).slice(1, -1)
  return new Promise((resolvePromise) => {
    let hit: SessionSearchHit | null = null
    const stream = createReadStream(filePath)
    const finish = () => resolvePromise(hit)
    const reader = createJsonlReader((line) => {
      if (!line.toLowerCase().includes(rawNeedle)) {
        return
      }
      let entry: { type?: unknown; message?: unknown }
      try {
        entry = JSON.parse(line) as { type?: unknown; message?: unknown }
      } catch {
        return
      }
      if (entry?.type !== 'message') {
        return
      }
      const found = messageText(entry.message)
      if (!found) {
        return
      }
      const at = found.text.toLowerCase().indexOf(needle)
      if (at === -1) {
        return
      }
      if (hit) {
        hit.matches += 1
      } else {
        hit = {
          sessionPath: filePath,
          role: found.role,
          snippet: snippetAround(found.text, at, needle.length),
          matches: 1
        }
      }
    })
    stream.on('data', (chunk: Buffer | string) => {
      if (!isCurrent()) {
        stream.destroy()
        finish()
        return
      }
      reader.push(chunk)
    })
    stream.on('end', () => {
      reader.end()
      finish()
    })
    stream.on('error', finish)
  })
}

let generation = 0

/**
 * Full-text search over session files (user prompts and assistant prose).
 * `files` should be ordered newest first; the scan stops once `limit`
 * sessions matched. A newer search cancels the one in flight.
 */
export async function searchSessions(
  files: string[],
  query: string,
  limit = 30
): Promise<SessionSearchHit[]> {
  const needle = query.trim().toLowerCase()
  const mine = ++generation
  if (needle.length < SEARCH_MIN_QUERY) {
    return []
  }
  const isCurrent = () => mine === generation
  const hits: (SessionSearchHit | null)[] = new Array(files.length).fill(null)
  let next = 0
  let found = 0
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, files.length) }, async () => {
    while (next < files.length && found < limit && isCurrent()) {
      const index = next++
      const hit = await searchFile(files[index]!, needle, isCurrent)
      if (hit) {
        hits[index] = hit
        found += 1
      }
    }
  })
  await Promise.all(workers)
  if (!isCurrent()) {
    return []
  }
  return hits.filter((h): h is SessionSearchHit => h !== null).slice(0, limit)
}
