import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Model, PiCommandInfo, ThinkingLevel } from '../../shared/pi-types'
import { appUserDataDir } from './app-paths'

/**
 * Last-known pi catalog (models, commands, thinking levels, defaults), kept
 * in userData so the composer and slash palette can render instantly while
 * a fresh pi process is still starting. Replaced by live data as soon as a
 * chat's pi process answers its first state request. Never written to
 * ~/.pi — this is app-owned state.
 */
export interface CatalogCache {
  models: Model[]
  commands: PiCommandInfo[]
  thinkingLevels: ThinkingLevel[]
  /** Last reported default/current model. */
  model: Model | null
  thinkingLevel: ThinkingLevel | null
  /** spawn → first answered request of the most recent chat, in ms. */
  lastStartupMs?: number
}

const WRITE_DEBOUNCE_MS = 500
const MAX_MODELS = 200
const MAX_COMMANDS = 500

function cacheFilePath(): string {
  return join(appUserDataDir(), 'catalog-cache.json')
}

function isModel(value: unknown): value is Model {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['id'] === 'string' &&
    typeof (value as Record<string, unknown>)['provider'] === 'string'
  )
}

function isCommand(value: unknown): value is PiCommandInfo {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['name'] === 'string'
  )
}

function isLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && /^[a-z]+$/.test(value)
}

function normalize(raw: unknown): CatalogCache | null {
  if (raw === null || typeof raw !== 'object') {
    return null
  }
  const input = raw as Record<string, unknown>
  const cache: CatalogCache = {
    models: [],
    commands: [],
    thinkingLevels: [],
    model: null,
    thinkingLevel: null
  }
  if (Array.isArray(input['models'])) {
    cache.models = input['models'].filter(isModel).slice(0, MAX_MODELS)
  }
  if (Array.isArray(input['commands'])) {
    cache.commands = input['commands'].filter(isCommand).slice(0, MAX_COMMANDS)
  }
  if (Array.isArray(input['thinkingLevels'])) {
    cache.thinkingLevels = input['thinkingLevels'].filter(isLevel)
  }
  if (isModel(input['model'])) {
    cache.model = input['model']
  }
  if (isLevel(input['thinkingLevel'])) {
    cache.thinkingLevel = input['thinkingLevel']
  }
  const startup = Number(input['lastStartupMs'])
  if (Number.isFinite(startup) && startup >= 0) {
    cache.lastStartupMs = Math.round(startup)
  }
  return cache
}

let cached: CatalogCache | null | undefined
let writeTimer: ReturnType<typeof setTimeout> | null = null

/** Load the persisted catalog once per app run; null when absent/invalid. */
export async function getCatalogCache(): Promise<CatalogCache | null> {
  if (cached !== undefined) {
    return cached
  }
  try {
    cached = normalize(JSON.parse(await readFile(cacheFilePath(), 'utf8')))
  } catch {
    cached = null
  }
  return cached
}

/**
 * Merge fresh live data into the cache and persist (debounced). Called by
 * ChatService whenever a pi process reports its catalog.
 */
export function updateCatalogCache(patch: Partial<CatalogCache>): void {
  const base: CatalogCache = cached ?? {
    models: [],
    commands: [],
    thinkingLevels: [],
    model: null,
    thinkingLevel: null
  }
  const next: CatalogCache = { ...base }
  if (Array.isArray(patch.models) && patch.models.length > 0) {
    next.models = patch.models.slice(0, MAX_MODELS)
  }
  if (Array.isArray(patch.commands) && patch.commands.length > 0) {
    next.commands = patch.commands.slice(0, MAX_COMMANDS)
  }
  if (Array.isArray(patch.thinkingLevels) && patch.thinkingLevels.length > 0) {
    next.thinkingLevels = patch.thinkingLevels
  }
  if (patch.model !== undefined) {
    next.model = patch.model
  }
  if (patch.thinkingLevel !== undefined) {
    next.thinkingLevel = patch.thinkingLevel
  }
  if (patch.lastStartupMs !== undefined) {
    next.lastStartupMs = patch.lastStartupMs
  }
  cached = next

  if (writeTimer) {
    clearTimeout(writeTimer)
  }
  writeTimer = setTimeout(() => {
    writeTimer = null
    const file = cacheFilePath()
    void mkdir(dirname(file), { recursive: true })
      .then(() => writeFile(file, JSON.stringify(next, null, 2) + '\n'))
      .catch(() => {})
  }, WRITE_DEBOUNCE_MS)
  writeTimer.unref?.()
}

/** Test hook: reset the in-memory cache. */
export function resetCatalogCache(): void {
  cached = undefined
}
