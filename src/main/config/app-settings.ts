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
  /** Project cwds expanded in the sidebar (all others stay collapsed). */
  expandedProjects: string[]
  /** Recently opened browser-panel URLs (http(s) only, newest first). */
  recentUrls: string[]
  sidebarCollapsed: boolean
  /** Right panel open state and pixel width, persisted across restarts. */
  panelOpen: boolean
  panelWidth: number
  /** Computer use: whether the agent may drive native macOS apps. */
  computerUse: { enabled: boolean }
  /** Native notifications + dock badge when pi finishes or needs input. */
  notifications: { enabled: boolean }
  /** First-run welcome checklist; dismissedAt is epoch ms. */
  onboarding: { dismissedAt?: number }
  /** Background check for newer app releases on GitHub. */
  updates: { check: boolean; dismissedVersion?: string }
  /** Dictation: speech locale (BCP-47) and silence auto-stop. */
  dictation: { locale?: string; autoStop: boolean }
  /** Remote control: whether paired phones may connect. */
  remote: { enabled: boolean }
  /**
   * Diff comments posted to a pull request: the `gh` account that posts
   * them (a bot account signed in with `gh auth login`), or the account gh
   * uses when unset.
   */
  github: { commentAccount?: string }
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
  expandedProjects: [],
  recentUrls: [],
  sidebarCollapsed: false,
  panelOpen: false,
  panelWidth: 400,
  computerUse: { enabled: true },
  notifications: { enabled: true },
  onboarding: {},
  updates: { check: true },
  dictation: { autoStop: false },
  remote: { enabled: false },
  github: {}
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

/** A GitHub login (letters, digits, single dashes, up to 39), or undefined. */
export function githubAccount(value: unknown): string | undefined {
  const login = typeof value === 'string' ? value.trim().replace(/^@/, '') : ''
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login) ? login : undefined
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
    piRuntime: { ...DEFAULT_APP_SETTINGS.piRuntime },
    computerUse: { ...DEFAULT_APP_SETTINGS.computerUse },
    notifications: { ...DEFAULT_APP_SETTINGS.notifications },
    onboarding: { ...DEFAULT_APP_SETTINGS.onboarding },
    updates: { ...DEFAULT_APP_SETTINGS.updates },
    dictation: { ...DEFAULT_APP_SETTINGS.dictation },
    remote: { ...DEFAULT_APP_SETTINGS.remote },
    github: {}
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
  // 'expandedProjects' replaced the old 'collapsedProjects' list: the new
  // default is collapsed, which already preserves every previously
  // collapsed project, so no explicit migration is needed.
  const expanded = normalizeCwdList(input['expandedProjects'])
  if (expanded) {
    settings.expandedProjects = expanded
  }
  const recent = input['recentUrls']
  if (Array.isArray(recent)) {
    settings.recentUrls = recent
      .filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u))
      .slice(0, 12)
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
  const computerUse = input['computerUse']
  if (computerUse !== null && typeof computerUse === 'object') {
    const cu = computerUse as Record<string, unknown>
    if (typeof cu['enabled'] === 'boolean') {
      settings.computerUse.enabled = cu['enabled']
    }
  }
  const notifications = input['notifications']
  if (notifications !== null && typeof notifications === 'object') {
    const n = notifications as Record<string, unknown>
    if (typeof n['enabled'] === 'boolean') {
      settings.notifications.enabled = n['enabled']
    }
  }
  const onboarding = input['onboarding']
  if (onboarding !== null && typeof onboarding === 'object') {
    const o = onboarding as Record<string, unknown>
    const at = Number(o['dismissedAt'])
    if (Number.isFinite(at) && at > 0) {
      settings.onboarding.dismissedAt = Math.floor(at)
    }
  }
  const updates = input['updates']
  if (updates !== null && typeof updates === 'object') {
    const u = updates as Record<string, unknown>
    if (typeof u['check'] === 'boolean') {
      settings.updates.check = u['check']
    }
    const dismissed = stringOrUndefined(u['dismissedVersion'], 64)
    if (dismissed) {
      settings.updates.dismissedVersion = dismissed
    }
  }
  const dictation = input['dictation']
  if (dictation !== null && typeof dictation === 'object') {
    const d = dictation as Record<string, unknown>
    const locale = stringOrUndefined(d['locale'], 64)
    if (locale) {
      settings.dictation.locale = locale
    }
    if (typeof d['autoStop'] === 'boolean') {
      settings.dictation.autoStop = d['autoStop']
    }
  }
  const remote = input['remote']
  if (remote !== null && typeof remote === 'object') {
    const r = remote as Record<string, unknown>
    if (typeof r['enabled'] === 'boolean') {
      settings.remote.enabled = r['enabled']
    }
  }
  const github = input['github']
  if (github !== null && typeof github === 'object') {
    const account = githubAccount((github as Record<string, unknown>)['commentAccount'])
    if (account) {
      settings.github.commentAccount = account
    }
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
    cached = normalizeAppSettings(undefined)
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
    const expanded = normalizeCwdList(input['expandedProjects'])
    if (expanded) {
      merged.expandedProjects = expanded
    }
    if (Array.isArray(input['recentUrls'])) {
      merged.recentUrls = input['recentUrls']
        .filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u))
        .slice(0, 12)
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
    if (input['computerUse'] !== null && typeof input['computerUse'] === 'object') {
      const cu = input['computerUse'] as Record<string, unknown>
      if (typeof cu['enabled'] === 'boolean') {
        merged.computerUse = { ...merged.computerUse, enabled: cu['enabled'] }
      }
    }
    if (input['notifications'] !== null && typeof input['notifications'] === 'object') {
      const n = input['notifications'] as Record<string, unknown>
      if (typeof n['enabled'] === 'boolean') {
        merged.notifications = { ...merged.notifications, enabled: n['enabled'] }
      }
    }
    if (input['onboarding'] !== null && typeof input['onboarding'] === 'object') {
      const o = input['onboarding'] as Record<string, unknown>
      if ('dismissedAt' in o) {
        const at = Number(o['dismissedAt'])
        merged.onboarding = {
          ...merged.onboarding,
          dismissedAt: Number.isFinite(at) && at > 0 ? Math.floor(at) : undefined
        }
      }
    }
    if (input['updates'] !== null && typeof input['updates'] === 'object') {
      const u = input['updates'] as Record<string, unknown>
      if (typeof u['check'] === 'boolean') {
        merged.updates = { ...merged.updates, check: u['check'] }
      }
      if ('dismissedVersion' in u) {
        merged.updates = {
          ...merged.updates,
          dismissedVersion: stringOrUndefined(u['dismissedVersion'], 64)
        }
      }
    }
    if (input['dictation'] !== null && typeof input['dictation'] === 'object') {
      const d = input['dictation'] as Record<string, unknown>
      merged.dictation = { ...merged.dictation }
      if ('locale' in d) {
        merged.dictation.locale = stringOrUndefined(d['locale'], 64)
      }
      if (typeof d['autoStop'] === 'boolean') {
        merged.dictation.autoStop = d['autoStop']
      }
    }
    if (input['remote'] !== null && typeof input['remote'] === 'object') {
      const r = input['remote'] as Record<string, unknown>
      if (typeof r['enabled'] === 'boolean') {
        merged.remote = { ...merged.remote, enabled: r['enabled'] }
      }
    }
    if (input['github'] !== null && typeof input['github'] === 'object') {
      const g = input['github'] as Record<string, unknown>
      if ('commentAccount' in g) {
        const account = githubAccount(g['commentAccount'])
        merged.github = account ? { commentAccount: account } : {}
      }
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

/**
 * Synchronous view of the last loaded settings — for spawn paths that can't
 * await. Returns null until the first loadAppSettings() resolves.
 */
export function getCachedAppSettings(): AppSettings | null {
  return cached
}
