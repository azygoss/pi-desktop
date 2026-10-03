import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import {
  MAX_AUTOMATIONS,
  isValidSchedule,
  type Automation
} from '../../shared/automations'
import { appUserDataDir } from '../config/app-paths'

const MAX_NAME = 80
const MAX_PROMPT = 20_000

let cache: Automation[] | null = null
let writeChain: Promise<void> = Promise.resolve()

function storePath(): string {
  return join(appUserDataDir(), 'automations.json')
}

function isAutomation(value: unknown): value is Automation {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const a = value as Record<string, unknown>
  return (
    typeof a['id'] === 'string' &&
    typeof a['name'] === 'string' &&
    typeof a['prompt'] === 'string' &&
    typeof a['cwd'] === 'string' &&
    typeof a['enabled'] === 'boolean' &&
    typeof a['createdAt'] === 'number' &&
    isValidSchedule(a['schedule']) &&
    (a['lastRunAt'] === undefined || typeof a['lastRunAt'] === 'number') &&
    (a['lastSessionPath'] === undefined || typeof a['lastSessionPath'] === 'string')
  )
}

async function load(): Promise<Automation[]> {
  if (cache) {
    return cache
  }
  cache = []
  try {
    const raw: unknown = JSON.parse(await readFile(storePath(), 'utf8'))
    const list = (raw as { automations?: unknown } | null)?.automations
    if (Array.isArray(list)) {
      cache = list.filter(isAutomation).slice(0, MAX_AUTOMATIONS)
    }
  } catch {
    // No store yet or corrupt — start empty.
  }
  return cache
}

function persist(): Promise<void> {
  writeChain = writeChain.then(async () => {
    const file = storePath()
    const tmp = `${file}.tmp-${process.pid}`
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(tmp, JSON.stringify({ version: 1, automations: cache ?? [] }, null, 2))
      await rename(tmp, file)
    } catch {
      // userData unavailable (tests) or unwritable — non-fatal
    }
  })
  return writeChain
}

export async function listAutomations(): Promise<Automation[]> {
  return [...(await load())]
}

/**
 * Create or update an automation from renderer input. Only the editable
 * fields are taken; run bookkeeping stays what the store has. Changing the
 * schedule restarts its clock so an edit never fires a run right away.
 */
export async function saveAutomation(input: unknown, now: number = Date.now()): Promise<Automation> {
  const i = (input ?? {}) as Record<string, unknown>
  const name = typeof i['name'] === 'string' ? i['name'].trim() : ''
  const prompt = typeof i['prompt'] === 'string' ? i['prompt'].trim() : ''
  const cwd = typeof i['cwd'] === 'string' ? i['cwd'] : ''
  if (!name || name.length > MAX_NAME) {
    throw new Error('An automation needs a name')
  }
  if (!prompt || prompt.length > MAX_PROMPT) {
    throw new Error('An automation needs a prompt')
  }
  if (cwd !== '' && !isAbsolute(cwd)) {
    throw new Error('Invalid project folder')
  }
  if (!isValidSchedule(i['schedule'])) {
    throw new Error('Invalid schedule')
  }
  const list = await load()
  const existing = typeof i['id'] === 'string' ? list.find((a) => a.id === i['id']) : undefined
  const scheduleChanged =
    existing !== undefined && JSON.stringify(existing.schedule) !== JSON.stringify(i['schedule'])
  const next: Automation = {
    id: existing?.id ?? randomUUID(),
    name,
    prompt,
    cwd,
    schedule: i['schedule'],
    enabled: i['enabled'] !== false,
    createdAt: existing && !scheduleChanged ? existing.createdAt : now,
    ...(existing?.lastRunAt !== undefined && !scheduleChanged
      ? { lastRunAt: existing.lastRunAt }
      : {}),
    ...(existing?.lastSessionPath !== undefined
      ? { lastSessionPath: existing.lastSessionPath }
      : {})
  }
  // Re-enabling restarts the clock too: time spent disabled is not "missed".
  if (existing && !existing.enabled && next.enabled) {
    next.createdAt = now
    delete next.lastRunAt
  }
  if (existing) {
    cache = list.map((a) => (a.id === existing.id ? next : a))
  } else {
    if (list.length >= MAX_AUTOMATIONS) {
      throw new Error(`At most ${MAX_AUTOMATIONS} automations`)
    }
    cache = [...list, next]
  }
  await persist()
  return next
}

export async function deleteAutomation(id: unknown): Promise<void> {
  const list = await load()
  cache = list.filter((a) => a.id !== id)
  await persist()
}

async function patch(id: string, change: Partial<Automation>): Promise<void> {
  const list = await load()
  cache = list.map((a) => (a.id === id ? { ...a, ...change } : a))
  await persist()
}

export function markAutomationRun(id: string, at: number): Promise<void> {
  return patch(id, { lastRunAt: at })
}

export function setAutomationSession(id: string, sessionPath: string): Promise<void> {
  return patch(id, { lastSessionPath: sessionPath })
}

/** Test hook. */
export function clearAutomationCache(): void {
  cache = null
}
