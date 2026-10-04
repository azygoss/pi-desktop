import { createReadStream } from 'node:fs'
import type { AgentMessage } from '../../shared/pi-types'
import { createJsonlReader } from '../pi/jsonl'

/**
 * How many message entries of the active branch are returned by default.
 * Long sessions expose a "Load earlier" affordance instead of rendering
 * thousands of rows at once.
 */
export const TRANSCRIPT_LIMIT = 2000

export interface TranscriptResult {
  /** Message entries of the active branch, oldest first. */
  messages: AgentMessage[]
  /** True when the active branch holds more messages than were returned. */
  hasEarlier: boolean
  /** Total message entries on the active branch. */
  totalMessages: number
  /** Index of the first returned message on the branch (for paging back). */
  startIndex?: number
}

interface SessionEntry {
  id: string
  parentId?: string
  message?: AgentMessage
}

/**
 * Read a pi session file and reconstruct the active conversation branch:
 * start at the file's last entry and walk `parentId` links to the root,
 * collecting `message` entries. This matches what the pi TUI shows,
 * including messages that predate a compaction. Malformed lines are
 * skipped. The file is streamed, never loaded whole.
 */
export function readSessionTranscript(
  filePath: string,
  options: { limit?: number; before?: number } = {}
): Promise<TranscriptResult> {
  const limit = Math.min(Math.max(options.limit ?? TRANSCRIPT_LIMIT, 1), 20_000)
  // Paging backwards: only messages before this index of the branch (the
  // ones from it on are already shown; new ones may have been appended).
  const before = options.before

  return new Promise((resolvePromise) => {
    const entries = new Map<string, SessionEntry>()
    let lastId: string | undefined

    const reader = createJsonlReader((line) => {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        return // tolerate malformed lines
      }
      if (parsed === null || typeof parsed !== 'object') {
        return
      }
      const id = typeof parsed['id'] === 'string' ? parsed['id'] : undefined
      if (!id) {
        return
      }
      const parentId =
        typeof parsed['parentId'] === 'string' ? (parsed['parentId'] as string) : undefined
      const entry: SessionEntry = { id, ...(parentId !== undefined ? { parentId } : {}) }
      if (parsed['type'] === 'message') {
        const message = parsed['message']
        if (message !== null && typeof message === 'object') {
          entry.message = message as AgentMessage
        }
      }
      entries.set(id, entry)
      lastId = id
    })

    const finish = () => {
      // Walk the active branch from the last entry back to the root.
      const branch: SessionEntry[] = []
      const seen = new Set<string>()
      let cursor = lastId
      while (cursor !== undefined) {
        if (seen.has(cursor)) {
          break // defensive: parentId cycle
        }
        seen.add(cursor)
        const entry = entries.get(cursor)
        if (!entry) {
          break // dangling parent (file truncated mid-write)
        }
        branch.push(entry)
        cursor = entry.parentId
      }
      branch.reverse()

      const all = branch.filter((e) => e.message !== undefined).map((e) => e.message!)
      const end =
        before === undefined ? all.length : Math.min(Math.max(Math.floor(before), 0), all.length)
      const start = Math.max(end - limit, 0)
      resolvePromise({
        messages: all.slice(start, end),
        hasEarlier: start > 0,
        totalMessages: all.length,
        startIndex: start
      })
    }

    const stream = createReadStream(filePath)
    stream.on('data', (chunk: Buffer | string) => reader.push(chunk))
    stream.on('end', () => {
      reader.end()
      finish()
    })
    stream.on('error', () => {
      stream.destroy()
      resolvePromise({ messages: [], hasEarlier: false, totalMessages: 0 })
    })
  })
}
