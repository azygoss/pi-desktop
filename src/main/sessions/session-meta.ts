import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { appUserDataDir } from '../config/app-paths'

/**
 * Pi Desktop's per-session metadata (pin/archive). This lives in Electron
 * userData — pi's own session files are never modified.
 */
import type { SessionMetaEntry, SessionMetaMap, SessionMetaPatch } from '../../shared/api'

export type { SessionMetaEntry, SessionMetaMap, SessionMetaPatch }

const WRITE_DEBOUNCE_MS = 200

let cache: Map<string, SessionMetaEntry> | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null
let writeChain: Promise<void> = Promise.resolve()

function metaPath(): string {
  return join(appUserDataDir(), 'session-meta.json')
}

function isEntry(value: unknown): value is SessionMetaEntry {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const e = value as Record<string, unknown>
  const valid = (v: unknown) => v === undefined || (typeof v === 'number' && v >= 0)
  return valid(e['pinned']) && valid(e['archived'])
}

/**
 * Load the store once and cache it. Entries whose session file no longer
 * exists are pruned lazily here — the delete action also removes entries
 * eagerly, this just covers files trashed outside the app.
 */
async function loadCache(): Promise<Map<string, SessionMetaEntry>> {
  if (cache) {
    return cache
  }
  cache = new Map()
  try {
    const raw: unknown = JSON.parse(await readFile(metaPath(), 'utf8'))
    const entries = (raw as { entries?: unknown } | null)?.entries
    if (entries !== null && typeof entries === 'object') {
      for (const [path, entry] of Object.entries(entries as Record<string, unknown>)) {
        if (isEntry(entry) && existsSync(path)) {
          cache.set(path, entry)
        }
      }
    }
  } catch {
    // No store yet or corrupt — start empty.
  }
  return cache
}

function persist(): Promise<void> {
  writeChain = writeChain.then(async () => {
    const file = metaPath()
    const tmp = `${file}.tmp-${process.pid}`
    try {
      await mkdir(dirname(file), { recursive: true })
      const entries = Object.fromEntries(cache ?? new Map())
      await writeFile(tmp, JSON.stringify({ version: 1, entries }))
      await rename(tmp, file)
    } catch {
      // userData unavailable (tests) or unwritable — non-fatal
    }
  })
  return writeChain
}

function schedulePersist(): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
  }
  writeTimer = setTimeout(() => {
    writeTimer = null
    void persist()
  }, WRITE_DEBOUNCE_MS)
  writeTimer.unref?.()
}

/** The whole meta map — one IPC payload, kept small by entry pruning. */
export async function getSessionMeta(): Promise<SessionMetaMap> {
  const map = await loadCache()
  return Object.fromEntries(map)
}

export async function setSessionMeta(
  sessionPath: string,
  patch: SessionMetaPatch
): Promise<SessionMetaMap> {
  const map = await loadCache()
  const current = map.get(sessionPath) ?? {}
  const next: SessionMetaEntry = { ...current }
  if (patch.pinned !== undefined) {
    if (patch.pinned) {
      next.pinned = Date.now()
    } else {
      delete next.pinned
    }
  }
  if (patch.archived !== undefined) {
    if (patch.archived) {
      next.archived = Date.now()
    } else {
      delete next.archived
    }
  }
  if (next.pinned === undefined && next.archived === undefined) {
    map.delete(sessionPath)
  } else {
    map.set(sessionPath, next)
  }
  schedulePersist()
  return Object.fromEntries(map)
}

/** Drop the entry when the session file is moved to Trash. */
export async function removeSessionMeta(sessionPath: string): Promise<void> {
  const map = await loadCache()
  if (map.delete(sessionPath)) {
    schedulePersist()
  }
}

/** Test hook: forget the cached map and any pending write. */
export function clearSessionMetaCache(): void {
  cache = null
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
}
