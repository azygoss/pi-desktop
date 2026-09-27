import { createReadStream, existsSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { collapseWhitespace, truncateText } from '../../shared/text'
import { titleFromUserText } from '../../shared/skill-prefix'
import type { ProjectSummary, SessionSummary } from '../../shared/session-types'
import { createJsonlReader } from '../pi/jsonl'
import { appUserDataDir } from '../config/app-paths'
import { getSessionsDir } from './paths'

export type { ProjectSummary, SessionSummary } from '../../shared/session-types'

const TITLE_MAX_LENGTH = 80
const WATCH_DEBOUNCE_MS = 300
const MAX_CONCURRENT_PARSES = 16

interface CacheEntry {
  mtimeMs: number
  size: number
  summary: SessionSummary
}

const summaryCache = new Map<string, CacheEntry>()

const PERSIST_DEBOUNCE_MS = 800
const PERSIST_MAX_ENTRIES = 5000
// Bump when the summary shape or title derivation changes so stale cached
// titles get recomputed instead of served.
const PERSIST_VERSION = 2

let persistedLoaded = false
let persistTimer: ReturnType<typeof setTimeout> | null = null

function persistPath(): string {
  return join(appUserDataDir(), 'session-index-cache.json')
}

function isPersistedSummary(value: unknown): value is SessionSummary {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const s = value as Record<string, unknown>
  return (
    typeof s['id'] === 'string' &&
    typeof s['path'] === 'string' &&
    typeof s['cwd'] === 'string' &&
    typeof s['title'] === 'string' &&
    typeof s['created'] === 'string' &&
    typeof s['modified'] === 'string' &&
    typeof s['messageCount'] === 'number'
  )
}

/**
 * Seed the in-memory cache from userData so a cold app start only has to
 * stat session files and reparse the ones whose mtime/size changed. Loaded
 * once per app run; a corrupt file simply means a cold start.
 */
async function loadPersistedCache(): Promise<void> {
  if (persistedLoaded) {
    return
  }
  persistedLoaded = true
  try {
    const raw: unknown = JSON.parse(await readFile(persistPath(), 'utf8'))
    if ((raw as { version?: unknown } | null)?.version !== PERSIST_VERSION) {
      return
    }
    const entries = (raw as { entries?: unknown[] } | null)?.entries
    if (!Array.isArray(entries)) {
      return
    }
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') {
        continue
      }
      const e = entry as Record<string, unknown>
      if (
        typeof e['path'] === 'string' &&
        typeof e['mtimeMs'] === 'number' &&
        typeof e['size'] === 'number' &&
        isPersistedSummary(e['summary'])
      ) {
        summaryCache.set(e['path'], {
          mtimeMs: e['mtimeMs'],
          size: e['size'],
          summary: e['summary']
        })
      }
    }
  } catch {
    // No cache yet or corrupt — fine.
  }
}

function schedulePersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
  }
  persistTimer = setTimeout(() => {
    persistTimer = null
    const entries = [...summaryCache.entries()]
      .map(([path, e]) => ({ path, mtimeMs: e.mtimeMs, size: e.size, summary: e.summary }))
      .slice(-PERSIST_MAX_ENTRIES)
    void (async () => {
      try {
        const file = persistPath()
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, JSON.stringify({ version: PERSIST_VERSION, entries }))
      } catch {
        // userData unavailable (tests) or unwritable — non-fatal
      }
    })()
  }, PERSIST_DEBOUNCE_MS)
  persistTimer.unref?.()
}

/** Test hook: drop all cached summaries and forget the disk seed ran. */
export function clearSessionIndexCache(): void {
  summaryCache.clear()
  persistedLoaded = false
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
}

interface ParsedSession {
  id: string
  cwd: string
  created: string
  name?: string
  parentSessionPath?: string
  messageCount: number
  firstUserText?: string
}

function userMessageText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text
      }
    }
  }
  return undefined
}

function applyLine(parsed: ParsedSession, line: string): void {
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return // tolerate malformed lines
  }
  if (entry === null || typeof entry !== 'object') {
    return
  }

  switch (entry['type']) {
    case 'session': {
      // Header line: id/timestamp/cwd(/parentSession), version may be absent in v1.
      if (typeof entry['id'] === 'string') {
        parsed.id = entry['id']
      }
      if (typeof entry['timestamp'] === 'string') {
        parsed.created = entry['timestamp']
      }
      if (typeof entry['cwd'] === 'string') {
        parsed.cwd = entry['cwd']
      }
      if (typeof entry['parentSession'] === 'string') {
        parsed.parentSessionPath = entry['parentSession']
      }
      break
    }
    case 'session_info': {
      if (typeof entry['name'] === 'string' && entry['name'].length > 0) {
        parsed.name = entry['name']
      }
      break
    }
    case 'message': {
      parsed.messageCount += 1
      const message = entry['message'] as Record<string, unknown> | undefined
      if (
        parsed.firstUserText === undefined &&
        message !== null &&
        typeof message === 'object' &&
        message['role'] === 'user'
      ) {
        parsed.firstUserText = userMessageText(message['content'])
      }
      break
    }
  }
}

/** Stream-parse one session file; files can be large so never load fully. */
function parseSessionFile(filePath: string): Promise<ParsedSession> {
  return new Promise((resolvePromise, reject) => {
    const parsed: ParsedSession = {
      id: basename(filePath, '.jsonl'),
      cwd: '',
      created: '',
      messageCount: 0
    }
    const reader = createJsonlReader((line) => applyLine(parsed, line))
    const stream = createReadStream(filePath)
    stream.on('data', (chunk: Buffer | string) => reader.push(chunk))
    stream.on('error', reject)
    stream.on('end', () => {
      reader.end()
      resolvePromise(parsed)
    })
  })
}

async function summarizeFile(filePath: string): Promise<SessionSummary | null> {
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch {
    return null
  }

  const cached = summaryCache.get(filePath)
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    return cached.summary
  }

  const parsed = await parseSessionFile(filePath)
  // Skill invocations expand to <skill> XML in the first user message; use
  // the typed remainder (or /skill:name) so titles never show raw markup.
  const titleSource = parsed.name ?? titleFromUserText(parsed.firstUserText)
  const title = titleSource
    ? truncateText(collapseWhitespace(titleSource), TITLE_MAX_LENGTH)
    : 'Untitled'

  const summary: SessionSummary = {
    id: parsed.id,
    path: filePath,
    cwd: parsed.cwd,
    title,
    created: parsed.created || fileStat.birthtime.toISOString(),
    modified: fileStat.mtime.toISOString(),
    messageCount: parsed.messageCount,
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    ...(parsed.parentSessionPath !== undefined
      ? { parentSessionPath: parsed.parentSessionPath }
      : {})
  }
  summaryCache.set(filePath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, summary })
  schedulePersist()
  return summary
}

/** List all sessions across projects, newest first. */
export async function listSessions(
  env: NodeJS.ProcessEnv = process.env
): Promise<SessionSummary[]> {
  const perfStart = process.env['PI_DESKTOP_PERF'] ? performance.now() : 0
  await loadPersistedCache()
  const sessionsDir = getSessionsDir(env)
  let projectDirs: string[]
  try {
    projectDirs = await readdir(sessionsDir)
  } catch {
    return []
  }

  const files: string[] = []
  await Promise.all(
    projectDirs.map(async (dirName) => {
      const dirPath = join(sessionsDir, dirName)
      try {
        const dirStat = await stat(dirPath)
        if (!dirStat.isDirectory()) {
          return
        }
        for (const file of await readdir(dirPath)) {
          if (file.endsWith('.jsonl')) {
            files.push(join(dirPath, file))
          }
        }
      } catch {
        // unreadable entry — skip
      }
    })
  )

  // Parse with bounded concurrency: session files can be large and numerous,
  // and unbounded parallel reads risk EMFILE.
  const summaries: (SessionSummary | null)[] = new Array(files.length).fill(null)
  let next = 0
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_PARSES, files.length) },
    async () => {
      while (next < files.length) {
        const index = next++
        summaries[index] = await summarizeFile(files[index]!)
      }
    }
  )
  await Promise.all(workers)

  // Drop cache entries for files that disappeared since the last scan.
  const present = new Set(files)
  for (const cachedPath of summaryCache.keys()) {
    if (!present.has(cachedPath)) {
      summaryCache.delete(cachedPath)
    }
  }

  const sorted = summaries
    .filter((s): s is SessionSummary => s !== null)
    .sort((a, b) => b.modified.localeCompare(a.modified))
  if (perfStart) {
    console.error(
      `perf sessions-scan ms=${Math.round(performance.now() - perfStart)} files=${files.length}`
    )
  }
  return sorted
}

/** Group sessions by working directory into project summaries. */
export function listProjects(sessions: SessionSummary[]): ProjectSummary[] {
  const byCwd = new Map<string, SessionSummary[]>()
  for (const session of sessions) {
    const group = byCwd.get(session.cwd)
    if (group) {
      group.push(session)
    } else {
      byCwd.set(session.cwd, [session])
    }
  }

  return [...byCwd.entries()]
    .map(([cwd, group]) => ({
      cwd,
      name: cwd ? basename(cwd) : 'Other',
      sessionCount: group.length,
      lastModified: group.reduce(
        (latest, s) => (s.modified > latest ? s.modified : latest),
        group[0]!.modified
      )
    }))
    .sort((a, b) => b.lastModified.localeCompare(a.lastModified))
}

/**
 * Watch the sessions directory and invoke `onChange` (debounced) when session
 * files change. Returns an unsubscribe function. Tolerates a missing
 * sessions directory and platforms without recursive watch.
 */
export function watchSessions(
  onChange: () => void,
  env: NodeJS.ProcessEnv = process.env
): () => void {
  const sessionsDir = getSessionsDir(env)
  let watcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null

  const notify = () => {
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(onChange, WATCH_DEBOUNCE_MS)
    timer.unref?.()
  }

  const startWatch = () => {
    try {
      watcher = watch(sessionsDir, { recursive: true }, notify)
    } catch {
      try {
        watcher = watch(sessionsDir, notify)
      } catch {
        watcher = null
      }
    }
    watcher?.on('error', () => {
      // Directory removed or watch unsupported; keep polling-free silence.
    })
  }

  if (existsSync(sessionsDir)) {
    startWatch()
  } else {
    // Sessions dir does not exist yet: poll cheaply until it appears, then watch.
    const poll = setInterval(() => {
      if (existsSync(sessionsDir)) {
        clearInterval(poll)
        startWatch()
      }
    }, 1000)
    poll.unref?.()
    return () => {
      clearInterval(poll)
      if (timer) {
        clearTimeout(timer)
      }
      watcher?.close()
    }
  }

  return () => {
    if (timer) {
      clearTimeout(timer)
    }
    watcher?.close()
  }
}
