import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { appUserDataDir } from './app-paths'

/**
 * Pi Desktop's own settings — stored in Electron userData, intentionally NOT
 * in ~/.pi/agent (pi owns that directory). Everything is validated on load;
 * corrupt or unexpected content falls back to defaults.
 */
export interface AppProject {
  cwd: string
  /** ISO timestamp of when the user added the project. */
  addedAt: string
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  displayName?: string
  defaultCwd?: string
  piRuntime: {
    mode: 'auto' | 'installed' | 'bundled' | 'custom'
    customPath?: string
  }
  /** Projects the user added explicitly (may have no sessions yet). */
  projects: AppProject[]
  hiddenProjects: string[]
  /** Project cwds whose sidebar rows are collapsed (expanded by default). */
  collapsedProjects: string[]
  sidebarCollapsed: boolean
  /** Right panel open state and pixel width, persisted across restarts. */
  panelOpen: boolean
  panelWidth: number
  /** Last window geometry; restored on launch when present. */
  windowBounds?: {
    width: number
    height: number
    x?: number
    y?: number
    maximized?: boolean
  }
}

export const PANEL_MIN_WIDTH = 320

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  piRuntime: { mode: 'auto' },
  projects: [],
  hiddenProjects: [],
  collapsedProjects: [],
  sidebarCollapsed: false,
  panelOpen: false,
  panelWidth: 400
}

export function settingsFilePath(): string {
  return join(appUserDataDir(), 'settings.json')
}

const THEMES = new Set(['system', 'light', 'dark'])
const RUNTIME_MODES = new Set(['auto', 'installed', 'bundled', 'custom'])

function stringOrUndefined(value: unknown, maxLength = 1024): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined
}

function normalizeProjects(value: unknown): AppProject[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const seen = new Set<string>()
  const projects: AppProject[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') {
      continue
    }
    const cwd = stringOrUndefined((item as Record<string, unknown>)['cwd'])
    const addedAt = stringOrUndefined((item as Record<string, unknown>)['addedAt'], 64)
    if (!cwd?.startsWith('/') || seen.has(cwd)) {
      continue
    }
    seen.add(cwd)
    projects.push({ cwd, addedAt: addedAt ?? '' })
  }
  return projects
}

function normalizeCwdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value.filter((p): p is string => typeof p === 'string' && p.startsWith('/'))
}

function normalizeWindowBounds(
  value: unknown
): AppSettings['windowBounds'] | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined
  }
  const b = value as Record<string, unknown>
  const width = Number(b['width'])
  const height = Number(b['height'])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 200) {
    return undefined
  }
  const bounds: NonNullable<AppSettings['windowBounds']> = {
    width: Math.min(Math.floor(width), 10000),
    height: Math.min(Math.floor(height), 10000)
  }
  const x = Number(b['x'])
  const y = Number(b['y'])
  if (Number.isFinite(x) && Number.isFinite(y)) {
    bounds.x = Math.floor(x)
    bounds.y = Math.floor(y)
  }
  if (typeof b['maximized'] === 'boolean') {
    bounds.maximized = b['maximized']
  }
  return bounds
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
  const projects = normalizeProjects(input['projects'])
  if (projects) {
    settings.projects = projects
  }
  const hidden = normalizeCwdList(input['hiddenProjects'])
  if (hidden) {
    settings.hiddenProjects = hidden
  }
  const collapsed = normalizeCwdList(input['collapsedProjects'])
  if (collapsed) {
    settings.collapsedProjects = collapsed
  }
  if (typeof input['sidebarCollapsed'] === 'boolean') {
    settings.sidebarCollapsed = input['sidebarCollapsed']
  }
  if (typeof input['panelOpen'] === 'boolean') {
    settings.panelOpen = input['panelOpen']
  }
  const panelWidth = Number(input['panelWidth'])
  if (Number.isFinite(panelWidth)) {
    settings.panelWidth = Math.max(PANEL_MIN_WIDTH, Math.min(1200, Math.floor(panelWidth)))
  }
  const bounds = normalizeWindowBounds(input['windowBounds'])
  if (bounds) {
    settings.windowBounds = bounds
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
    const projects = normalizeProjects(input['projects'])
    if (projects) {
      merged.projects = projects
    }
    const hidden = normalizeCwdList(input['hiddenProjects'])
    if (hidden) {
      merged.hiddenProjects = hidden
    }
    const collapsed = normalizeCwdList(input['collapsedProjects'])
    if (collapsed) {
      merged.collapsedProjects = collapsed
    }
    if (typeof input['sidebarCollapsed'] === 'boolean') {
      merged.sidebarCollapsed = input['sidebarCollapsed']
    }
    if (typeof input['panelOpen'] === 'boolean') {
      merged.panelOpen = input['panelOpen']
    }
    const panelWidth = Number(input['panelWidth'])
    if (Number.isFinite(panelWidth)) {
      merged.panelWidth = Math.max(PANEL_MIN_WIDTH, Math.min(1200, Math.floor(panelWidth)))
    }
    const bounds = normalizeWindowBounds(input['windowBounds'])
    if (bounds) {
      merged.windowBounds = bounds
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
