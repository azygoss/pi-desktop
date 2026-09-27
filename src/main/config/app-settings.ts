import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/**
 * Pi Desktop's own settings — stored in Electron userData, intentionally NOT
 * in ~/.pi/agent (pi owns that directory). Everything is validated on load;
 * corrupt or unexpected content falls back to defaults.
 */
export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  displayName?: string
  defaultCwd?: string
  piRuntime: {
    mode: 'auto' | 'installed' | 'bundled' | 'custom'
    customPath?: string
  }
  hiddenProjects: string[]
  sidebarCollapsed: boolean
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  piRuntime: { mode: 'auto' },
  hiddenProjects: [],
  sidebarCollapsed: false
}

export function settingsFilePath(): string {
  const override = process.env['PI_DESKTOP_USER_DATA_DIR']
  const base = override || app.getPath('userData')
  return join(base, 'settings.json')
}

const THEMES = new Set(['system', 'light', 'dark'])
const RUNTIME_MODES = new Set(['auto', 'installed', 'bundled', 'custom'])

function stringOrUndefined(value: unknown, maxLength = 1024): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined
}

export function normalizeAppSettings(raw: unknown): AppSettings {
  const settings: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    piRuntime: { ...DEFAULT_APP_SETTINGS.piRuntime }
  }
  if (raw === null || typeof raw !== 'object') {
    return settings
  }
  const input = raw as Record<string, unknown>
  if (THEMES.has(input['theme'] as string)) {
    settings.theme = input['theme'] as AppSettings['theme']
  }
  const displayName = stringOrUndefined(input['displayName'], 80)
  if (displayName) {
    settings.displayName = displayName
  }
  const defaultCwd = stringOrUndefined(input['defaultCwd'])
  if (defaultCwd?.startsWith('/')) {
    settings.defaultCwd = defaultCwd
  }
  const piRuntime = input['piRuntime']
  if (piRuntime !== null && typeof piRuntime === 'object') {
    const rt = piRuntime as Record<string, unknown>
    if (RUNTIME_MODES.has(rt['mode'] as string)) {
      settings.piRuntime.mode = rt['mode'] as AppSettings['piRuntime']['mode']
    }
    const customPath = stringOrUndefined(rt['customPath'])
    if (customPath) {
      settings.piRuntime.customPath = customPath
    }
  }
  if (Array.isArray(input['hiddenProjects'])) {
    settings.hiddenProjects = input['hiddenProjects'].filter(
      (p): p is string => typeof p === 'string' && p.startsWith('/')
    )
  }
  if (typeof input['sidebarCollapsed'] === 'boolean') {
    settings.sidebarCollapsed = input['sidebarCollapsed']
  }
  return settings
}

let cached: AppSettings | null = null

export async function loadAppSettings(): Promise<AppSettings> {
  if (cached) {
    return cached
  }
  try {
    const raw = await readFile(settingsFilePath(), 'utf8')
    cached = normalizeAppSettings(JSON.parse(raw))
  } catch {
    cached = { ...DEFAULT_APP_SETTINGS, piRuntime: { ...DEFAULT_APP_SETTINGS.piRuntime } }
  }
  return cached
}

/** Merge a partial update, persist and return the new settings. */
export async function updateAppSettings(patch: unknown): Promise<AppSettings> {
  const current = await loadAppSettings()
  const merged = { ...current, piRuntime: { ...current.piRuntime } }
  if (patch !== null && typeof patch === 'object') {
    const input = patch as Record<string, unknown>
    if (THEMES.has(input['theme'] as string)) {
      merged.theme = input['theme'] as AppSettings['theme']
    }
    if ('displayName' in input) {
      merged.displayName = stringOrUndefined(input['displayName'], 80)
    }
    if ('defaultCwd' in input) {
      const cwd = stringOrUndefined(input['defaultCwd'])
      merged.defaultCwd = cwd?.startsWith('/') ? cwd : undefined
    }
    if (input['piRuntime'] !== null && typeof input['piRuntime'] === 'object') {
      const rt = input['piRuntime'] as Record<string, unknown>
      if (RUNTIME_MODES.has(rt['mode'] as string)) {
        merged.piRuntime.mode = rt['mode'] as AppSettings['piRuntime']['mode']
      }
      if ('customPath' in rt) {
        merged.piRuntime.customPath = stringOrUndefined(rt['customPath'])
      }
    }
    if (Array.isArray(input['hiddenProjects'])) {
      merged.hiddenProjects = input['hiddenProjects'].filter(
        (p): p is string => typeof p === 'string' && p.startsWith('/')
      )
    }
    if (typeof input['sidebarCollapsed'] === 'boolean') {
      merged.sidebarCollapsed = input['sidebarCollapsed']
    }
  }
  cached = merged
  const file = settingsFilePath()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(merged, null, 2) + '\n')
  return merged
}

/** Test hook: reset the cached settings. */
export function resetAppSettingsCache(): void {
  cached = null
}
