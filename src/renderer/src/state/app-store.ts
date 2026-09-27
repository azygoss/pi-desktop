import { create } from 'zustand'
import type {
  PiRuntimeInfo,
  PiSettings,
  ProjectSummary,
  SessionSummary
} from '../../../shared/session-types'

export type ViewState = { kind: 'home' } | { kind: 'chat'; chatId: string }

interface AppState {
  ready: boolean
  piAvailable: boolean
  runtimeInfo: PiRuntimeInfo | null
  settings: PiSettings
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

  init(): Promise<void>
  refreshSessions(): Promise<void>
  navigate(view: ViewState): void
  goBack(): void
  goForward(): void
  toggleSidebar(): void
  setChatFilter(filter: string): void
  setActiveProjectCwd(cwd: string | null): void
  setShowAllProjects(show: boolean): void
  renameSession(path: string, title: string): void
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  piAvailable: true,
  runtimeInfo: null,
  settings: {},
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

  async init() {
    try {
      const [runtimeInfo, settings, userName, sessions, projects] = await Promise.all([
        window.piDesktop.runtime.info().catch(() => null),
        window.piDesktop.settings.get().catch(() => ({})),
        window.piDesktop.app.getUserFirstName().catch(() => 'there'),
        window.piDesktop.sessions.list().catch(() => []),
        window.piDesktop.projects.list().catch(() => [])
      ])
      set({
        ready: true,
        piAvailable: runtimeInfo !== null,
        runtimeInfo,
        settings,
        userName,
        sessions,
        projects
      })
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
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))
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
  }
}))
