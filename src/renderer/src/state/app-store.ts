import { create } from 'zustand'
import type { AppSettings } from '../../../shared/api'
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
  hiddenProjects: [],
  sidebarCollapsed: false
}

interface AppState {
  ready: boolean
  piAvailable: boolean
  runtimeInfo: PiRuntimeInfo | null
  settings: PiSettings
  appSettings: AppSettings
  userName: string
  sessions: SessionSummary[]
  projects: ProjectSummary[]
  sidebarCollapsed: boolean
  chatFilter: string
  activeProjectCwd: string | null
  showAllProjects: boolean
  view: ViewState
  backStack: ViewState[]
  forwardStack: ViewState[]
  settingsOpen: boolean

  init(): Promise<void>
  refreshSessions(): Promise<void>
  updateAppSettings(patch: Partial<AppSettings>): Promise<void>
  navigate(view: ViewState): void
  goBack(): void
  goForward(): void
  toggleSidebar(): void
  setChatFilter(filter: string): void
  setActiveProjectCwd(cwd: string | null): void
  setShowAllProjects(show: boolean): void
  renameSession(path: string, title: string): void
  openSettings(): void
  closeSettings(): void
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  piAvailable: true,
  runtimeInfo: null,
  settings: {},
  appSettings: DEFAULT_APP_SETTINGS,
  userName: 'there',
  sessions: [],
  projects: [],
  sidebarCollapsed: false,
  chatFilter: '',
  activeProjectCwd: null,
  showAllProjects: false,
  view: { kind: 'home' },
  backStack: [],
  forwardStack: [],
  settingsOpen: false,

  async init() {
    try {
      const [runtimeInfo, settings, appSettings, userName, sessions, projects] = await Promise.all([
        window.piDesktop.runtime.info().catch(() => null),
        window.piDesktop.settings.get().catch(() => ({})),
        window.piDesktop.appSettings.get().catch(() => DEFAULT_APP_SETTINGS),
        window.piDesktop.app.getUserFirstName().catch(() => 'there'),
        window.piDesktop.sessions.list().catch(() => []),
        window.piDesktop.projects.list().catch(() => [])
      ])
      set({
        ready: true,
        piAvailable: runtimeInfo !== null,
        runtimeInfo,
        settings,
        appSettings,
        userName: appSettings.displayName?.trim() || userName,
        sidebarCollapsed: appSettings.sidebarCollapsed,
        sessions,
        projects
      })
      applyTheme(appSettings.theme)
    } catch {
      set({ ready: true, piAvailable: false })
    }
  },

  async refreshSessions() {
    try {
      const [sessions, projects] = await Promise.all([
        window.piDesktop.sessions.list(),
        window.piDesktop.projects.list()
      ])
      set({ sessions, projects })
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
      if (patch.hiddenProjects !== undefined || patch.defaultCwd !== undefined) {
        void get().refreshSessions()
      }
    } catch {
      // settings file may be unavailable; keep previous state
    }
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

  setActiveProjectCwd(cwd) {
    set((s) => ({ activeProjectCwd: s.activeProjectCwd === cwd ? null : cwd }))
  },

  setShowAllProjects(show) {
    set({ showAllProjects: show })
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
