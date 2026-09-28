import { create } from 'zustand'
import type { AppInfo, AppSettings } from '../../../shared/api'
import type {
  PiRuntimeInfo,
  PiSettings,
  ProjectSummary,
  SessionSummary
} from '../../../shared/session-types'

export type ViewState = { kind: 'home' } | { kind: 'chat'; chatId: string }

const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  piRuntime: { mode: 'auto' },
  projects: [],
  hiddenProjects: [],
  expandedProjects: [],
  recentUrls: [],
  sidebarCollapsed: false,
  panelOpen: false,
  panelWidth: 400,
  computerUse: { enabled: true }
}

interface AppState {
  ready: boolean
  piAvailable: boolean
  runtimeInfo: PiRuntimeInfo | null
  settings: PiSettings
  appSettings: AppSettings
  appInfo: AppInfo | null
  userName: string
  sessions: SessionSummary[]
  /** False until the first session index answer arrives (skeleton rows). */
  sessionsLoaded: boolean
  projects: ProjectSummary[]
  sidebarCollapsed: boolean
  chatFilter: string
  /** Whether the sidebar search field is visible/focused (⌘⇧F, /resume). */
  sidebarSearchOpen: boolean
  /** ⌘K command palette. */
  paletteOpen: boolean
  view: ViewState
  backStack: ViewState[]
  forwardStack: ViewState[]
  settingsOpen: boolean
  /** Slash-command modal open over the current chat (/session, /tree, …). */
  chatModal: 'session' | 'tree' | 'fork' | 'hotkeys' | null

  init(): Promise<void>
  refreshSessions(): Promise<void>
  updateAppSettings(patch: Partial<AppSettings>): Promise<void>
  /** Register a project folder picked via the native dialog. */
  addProject(cwd: string): Promise<void>
  /** Expand/collapse a project row in the sidebar (persisted). */
  toggleProjectExpanded(cwd: string): void
  navigate(view: ViewState): void
  goBack(): void
  goForward(): void
  toggleSidebar(): void
  setChatFilter(filter: string): void
  setSidebarSearchOpen(open: boolean): void
  setPaletteOpen(open: boolean): void
  renameSession(path: string, title: string): void
  openSettings(): void
  closeSettings(): void
  setChatModal(modal: AppState['chatModal']): void
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  piAvailable: true,
  runtimeInfo: null,
  settings: {},
  appSettings: DEFAULT_APP_SETTINGS,
  appInfo: null,
  userName: 'there',
  sessions: [],
  sessionsLoaded: false,
  projects: [],
  sidebarCollapsed: false,
  chatFilter: '',
  sidebarSearchOpen: false,
  paletteOpen: false,
  view: { kind: 'home' },
  backStack: [],
  forwardStack: [],
  settingsOpen: false,
  chatModal: null,

  async init() {
    try {
      const [runtimeInfo, settings, appSettings, userName, sessions, projects, appInfo] =
        await Promise.all([
          window.piDesktop.runtime.info().catch(() => null),
          window.piDesktop.settings.get().catch(() => ({})),
          window.piDesktop.appSettings.get().catch(() => DEFAULT_APP_SETTINGS),
          window.piDesktop.app.getUserFirstName().catch(() => 'there'),
          window.piDesktop.sessions.list().catch(() => []),
          window.piDesktop.projects.list().catch(() => []),
          window.piDesktop.app.getAppInfo().catch(() => null)
        ])
      set({
        ready: true,
        piAvailable: runtimeInfo !== null,
        runtimeInfo,
        settings,
        appSettings,
        appInfo,
        userName: appSettings.displayName?.trim() || userName,
        sidebarCollapsed: appSettings.sidebarCollapsed,
        sessions,
        sessionsLoaded: true,
        projects
      })
      applyTheme(appSettings.theme)
      applyPlatform(appInfo?.platform)
    } catch {
      set({ ready: true, piAvailable: false })
      applyPlatform()
    }
  },

  async refreshSessions() {
    try {
      const [sessions, projects] = await Promise.all([
        window.piDesktop.sessions.list(),
        window.piDesktop.projects.list()
      ])
      set({ sessions, projects, sessionsLoaded: true })
    } catch {
      // keep stale data
    }
  },

  async updateAppSettings(patch) {
    try {
      const next = await window.piDesktop.appSettings.update(patch)
      set((s) => ({
        appSettings: next,
        userName:
          next.displayName?.trim() ||
          (patch.displayName !== undefined ? 'there' : s.userName)
      }))
      if (patch.theme !== undefined) {
        applyTheme(next.theme)
      }
      if (
        patch.hiddenProjects !== undefined ||
        patch.projects !== undefined ||
        patch.defaultCwd !== undefined
      ) {
        void get().refreshSessions()
      }
    } catch {
      // settings file may be unavailable; keep previous state
    }
  },

  async addProject(cwd) {
    try {
      await window.piDesktop.projects.add({ cwd })
      // Also unhide it if it was previously hidden.
      const settings = get().appSettings
      if (settings.hiddenProjects.includes(cwd)) {
        await get().updateAppSettings({
          hiddenProjects: settings.hiddenProjects.filter((c) => c !== cwd)
        })
      }
      await get().refreshSessions()
    } catch {
      // invalid folder; ignore
    }
  },

  toggleProjectExpanded(cwd) {
    const expanded = get().appSettings.expandedProjects
    const next = expanded.includes(cwd)
      ? expanded.filter((c) => c !== cwd)
      : [...expanded, cwd]
    void get().updateAppSettings({ expandedProjects: next })
  },

  navigate(view) {
    const current = get().view
    if (view.kind === current.kind && view.kind === 'chat' && view.chatId === (current as { chatId?: string }).chatId) {
      return
    }
    set((s) => ({
      view,
      backStack: [...s.backStack, current],
      forwardStack: []
    }))
  },

  goBack() {
    const { backStack, forwardStack, view } = get()
    const prev = backStack[backStack.length - 1]
    if (!prev) {
      return
    }
    set({
      view: prev,
      backStack: backStack.slice(0, -1),
      forwardStack: [...forwardStack, view]
    })
  },

  goForward() {
    const { backStack, forwardStack, view } = get()
    const next = forwardStack[forwardStack.length - 1]
    if (!next) {
      return
    }
    set({
      view: next,
      backStack: [...backStack, view],
      forwardStack: forwardStack.slice(0, -1)
    })
  },

  toggleSidebar() {
    const sidebarCollapsed = !get().sidebarCollapsed
    set({ sidebarCollapsed })
    void window.piDesktop.appSettings.update({ sidebarCollapsed }).catch(() => {})
  },

  setChatFilter(filter) {
    set({ chatFilter: filter })
  },

  setSidebarSearchOpen(open) {
    set({ sidebarSearchOpen: open })
  },

  setPaletteOpen(open) {
    set({ paletteOpen: open })
  },

  renameSession(path, title) {
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.path === path ? { ...session, name: title, title } : session
      )
    }))
  },

  openSettings() {
    set({ settingsOpen: true })
  },

  closeSettings() {
    set({ settingsOpen: false })
  },

  setChatModal(modal) {
    set({ chatModal: modal })
  }
}))

/** Apply the theme setting; 'system' clears the override so the media query rules. */
function applyTheme(theme: AppSettings['theme']): void {
  if (typeof document === 'undefined') {
    return
  }
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.dataset['theme'] = theme
  }
}

/**
 * Tag the root element with the platform so macOS-only styling (vibrancy
 * transparency) can apply. Falls back to `navigator.platform` when the
 * app-info call failed.
 */
function applyPlatform(platform?: string): void {
  if (typeof document === 'undefined') {
    return
  }
  const value =
    platform ??
    (typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')
      ? 'darwin'
      : 'other')
  document.documentElement.dataset['platform'] = value
}
