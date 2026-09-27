import { createReadStream, existsSync, watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { collapseWhitespace, truncateText } from '../../shared/text'
import type { ProjectSummary, SessionSummary } from '../../shared/session-types'
import { createJsonlReader } from '../pi/jsonl'
import { getSessionsDir } from './paths'

export type { ProjectSummary, SessionSummary } from '../../shared/session-types'

const TITLE_MAX_LENGTH = 80
const WATCH_DEBOUNCE_MS = 300

interface CacheEntry {
  mtimeMs: number
  size: number
  summary: SessionSummary
}

const summaryCache = new Map<string, CacheEntry>()

/** Test hook: drop all cached summaries. */
export function clearSessionIndexCache(): void {
  summaryCache.clear()
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
  const titleSource = parsed.name ?? parsed.firstUserText
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
  return summary
}

/** List all sessions across projects, newest first. */
export async function listSessions(env: NodeJS.ProcessEnv = process.env): Promise<SessionSummary[]> {
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

  const summaries = await Promise.all(files.map(summarizeFile))
  return summaries
    .filter((s): s is SessionSummary => s !== null)
    .sort((a, b) => b.modified.localeCompare(a.modified))
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
