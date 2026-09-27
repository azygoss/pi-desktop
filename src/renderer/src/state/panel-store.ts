import { create } from 'zustand'

import type { BrowserTabState, TerminalProfile } from '../../../shared/api'
import { toast } from './toast-store'

export const PANEL_MIN_WIDTH = 320
const PANEL_MAX_RATIO = 0.7
const DIFF_TAB_ID = 'diff'

export interface TerminalTabSpec {
  cwd: string
  /** Empty/omitted → login shell. */
  argv?: string[]
  profile?: TerminalProfile
  initialInput?: string
}

export type PanelTab =
  | {
      id: string
      kind: 'terminal'
      title: string
      spec: TerminalTabSpec
      /** Set once the pty spawned; cleared on exit. */
      exited?: boolean
    }
  | {
      id: string
      kind: 'browser'
      title: string
      url: string
      favicon?: string
      loading?: boolean
      canGoBack?: boolean
      canGoForward?: boolean
      /** Set for tabs owned by a pi agent's browser tools (section E). */
      agentChatId?: string
    }
  | { id: string; kind: 'diff' }
  | { id: string; kind: 'newtab' }

interface PanelState {
  hydrated: boolean
  open: boolean
  /** True while the open/close width animation runs (~190ms). */
  animating: boolean
  width: number
  tabs: PanelTab[]
  activeTabId: string | null
  /** Recently visited browser URLs, newest first (persisted). */
  recentUrls: string[]

  /** Seed open/width/recents from persisted app settings (once at startup). */
  hydrate(open: boolean, width: number, recentUrls?: string[]): void
  setOpen(open: boolean): void
  togglePanel(): void
  setWidth(width: number): void
  addNewTab(): string
  /** Turn a new-tab page into a browser tab navigated to `url`. */
  convertNewTab(id: string, url: string): void
  openTerminal(spec: TerminalTabSpec, title: string): string
  openBrowser(url: string, opts?: { title?: string; agentChatId?: string }): string
  /**
   * Register + focus a browser tab created in main by the agent bridge
   * (the WebContentsView already exists; this only mirrors it in the panel).
   */
  focusAgentTab(id: string, chatId: string): void
  /** Focus the one diff tab, creating it if needed. */
  openDiff(): void
  /** Focus an existing terminal tab or create a fresh shell terminal. */
  toggleTerminal(cwd: string): void
  activate(id: string): void
  closeTab(id: string): void
  markExited(id: string): void
  /** Merge main-process browser state into a browser tab. */
  applyBrowserState(state: BrowserTabState): void
}

let widthPersistTimer: ReturnType<typeof setTimeout> | null = null
let animTimer: ReturnType<typeof setTimeout> | null = null

export const PANEL_ANIM_MS = 180

/** Flag a ~180ms window during which browser views stay hidden while the
 *  panel width animates; the active tab pushes final bounds afterwards. */
function beginAnimation(set: (partial: Partial<PanelState>) => void): void {
  set({ animating: true })
  if (animTimer) {
    clearTimeout(animTimer)
  }
  animTimer = setTimeout(() => {
    animTimer = null
    usePanelStore.setState({ animating: false })
  }, PANEL_ANIM_MS + 20)
}

/** Remember a visited http(s) URL for the new-tab page's Recent list. */
function recordRecentUrl(url: string): void {
  if (!/^https?:\/\//.test(url)) {
    return
  }
  const current = usePanelStore.getState().recentUrls
  const next = [url, ...current.filter((u) => u !== url)].slice(0, 8)
  if (next.length === current.length && next.every((u, i) => u === current[i])) {
    return
  }
  usePanelStore.setState({ recentUrls: next })
  void window.piDesktop.appSettings.update({ recentUrls: next }).catch(() => {})
}

function persistOpen(open: boolean): void {
  void window.piDesktop.appSettings.update({ panelOpen: open }).catch(() => {})
}

function persistWidth(width: number): void {
  if (widthPersistTimer) {
    clearTimeout(widthPersistTimer)
  }
  widthPersistTimer = setTimeout(() => {
    void window.piDesktop.appSettings.update({ panelWidth: width }).catch(() => {})
  }, 500)
}

export const usePanelStore = create<PanelState>((set, get) => ({
  hydrated: false,
  open: false,
  animating: false,
  width: 400,
  tabs: [],
  activeTabId: null,
  recentUrls: [],

  hydrate(open, width, recentUrls) {
    if (get().hydrated) {
      return
    }
    set({
      hydrated: true,
      open,
      width: Math.max(PANEL_MIN_WIDTH, width),
      recentUrls: recentUrls ?? []
    })
  },

  setOpen(open) {
    if (open !== get().open) {
      beginAnimation(set)
    }
    set({ open })
    persistOpen(open)
  },

  togglePanel() {
    get().setOpen(!get().open)
  },

  setWidth(width) {
    const max = Math.max(PANEL_MIN_WIDTH, Math.round(window.innerWidth * PANEL_MAX_RATIO))
    const clamped = Math.max(PANEL_MIN_WIDTH, Math.min(max, Math.round(width)))
    set({ width: clamped })
    persistWidth(clamped)
  },

  addNewTab() {
    const id = crypto.randomUUID()
    if (!get().open) {
      beginAnimation(set)
    }
    set((s) => ({
      open: true,
      tabs: [...s.tabs, { id, kind: 'newtab' }],
      activeTabId: id
    }))
    return id
  },

  convertNewTab(id, url) {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id && t.kind === 'newtab'
          ? { id, kind: 'browser' as const, title: 'New Tab', url }
          : t
      )
    }))
    void window.piDesktop.browser.create({ id, url }).catch((e) => {
      toast(`Could not open browser: ${String(e)}`)
      get().closeTab(id)
    })
  },

  openTerminal(spec, title) {
    const id = crypto.randomUUID()
    if (!get().open) {
      beginAnimation(set)
    }
    set((s) => ({
      open: true,
      tabs: [...s.tabs, { id, kind: 'terminal', title, spec }],
      activeTabId: id
    }))
    return id
  },

  openBrowser(url, opts) {
    const id = crypto.randomUUID()
    if (!get().open) {
      beginAnimation(set)
    }
    recordRecentUrl(url)
    set((s) => ({
      open: true,
      tabs: [
        ...s.tabs,
        {
          id,
          kind: 'browser',
          title: opts?.title ?? 'New Tab',
          url,
          agentChatId: opts?.agentChatId
        }
      ],
      activeTabId: id
    }))
    void window.piDesktop.browser.create({ id, url }).catch((e) => {
      toast(`Could not open browser: ${String(e)}`)
      get().closeTab(id)
    })
    return id
  },

  focusAgentTab(id, chatId) {
    set((s) => {
      // One agent tab per chat. Reuse it when it exists — even after the
      // panel was closed and reopened — and never adopt a user-opened tab
      // (those have no agentChatId and UUID ids that can't collide with
      // the 'agent-<chatId>' namespace).
      const existing = s.tabs.find((t) => t.kind === 'browser' && t.agentChatId === chatId)
      if (existing) {
        if (!s.open) {
          beginAnimation(set)
        }
        return { open: true, activeTabId: existing.id }
      }
      if (!s.open) {
        beginAnimation(set)
      }
      return {
        open: true,
        tabs: [
          ...s.tabs,
          { id, kind: 'browser' as const, title: 'Pi', url: '', agentChatId: chatId }
        ],
        activeTabId: id
      }
    })
  },

  openDiff() {
    if (!get().open) {
      beginAnimation(set)
    }
    const existing = get().tabs.find((t) => t.id === DIFF_TAB_ID)
    if (existing) {
      set({ open: true, activeTabId: DIFF_TAB_ID })
      return
    }
    set((s) => ({
      open: true,
      tabs: [...s.tabs, { id: DIFF_TAB_ID, kind: 'diff' }],
      activeTabId: DIFF_TAB_ID
    }))
  },

  toggleTerminal(cwd) {
    const { tabs, open, activeTabId } = get()
    const existing = tabs.find((t) => t.kind === 'terminal' && !t.exited)
    if (!open) {
      if (existing) {
        beginAnimation(set)
        set({ open: true, activeTabId: existing.id })
      } else {
        get().openTerminal({ cwd }, 'Terminal')
      }
      return
    }
    if (!existing) {
      get().openTerminal({ cwd }, 'Terminal')
      return
    }
    if (activeTabId !== existing.id) {
      set({ activeTabId: existing.id })
      return
    }
    // Panel open on a terminal: a second press closes the panel.
    get().setOpen(false)
  },

  activate(id) {
    if (!get().open) {
      beginAnimation(set)
    }
    set({ activeTabId: id, open: true })
  },

  closeTab(id) {
    const tab = get().tabs.find((t) => t.id === id)
    if (tab?.kind === 'browser') {
      void window.piDesktop.browser.close({ id }).catch(() => {})
    } else if (tab?.kind === 'terminal') {
      void window.piDesktop.terminal.kill({ id }).catch(() => {})
    }
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTabId =
        s.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId
      return { tabs, activeTabId }
    })
  },

  markExited(id) {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id && t.kind === 'terminal' ? { ...t, exited: true } : t))
    }))
  },

  applyBrowserState(state) {
    const tab = get().tabs.find((t) => t.id === state.id)
    // Agent-owned tabs don't count as "the user visited this".
    if (state.url && !(tab?.kind === 'browser' && tab.agentChatId)) {
      recordRecentUrl(state.url)
    }
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === state.id && t.kind === 'browser'
          ? {
              ...t,
              url: state.url || t.url,
              title: state.title || 'New Tab',
              favicon: state.favicon,
              loading: state.loading,
              canGoBack: state.canGoBack,
              canGoForward: state.canGoForward
            }
          : t
      )
    }))
  }
}))

/** Wire pty/browser events → tab state once per session. */
let ptyBridgeReady = false
export function initPanelBridge(): void {
  if (ptyBridgeReady) {
    return
  }
  ptyBridgeReady = true
  window.piDesktop.terminal.onExit(({ id }) => {
    usePanelStore.getState().markExited(id)
  })
  window.piDesktop.browser.onState((state) => {
    usePanelStore.getState().applyBrowserState(state)
  })
  window.piDesktop.browser.onOpenUrl(({ url }) => {
    usePanelStore.getState().openBrowser(url)
  })
  window.piDesktop.browser.onDownload(({ filename }) => {
    toast(`Downloaded ${filename}`)
  })
  window.piDesktop.browser.onAgentTab(({ id, chatId, action }) => {
    const store = usePanelStore.getState()
    if (action === 'close') {
      // The view is already gone in main; remove the tab without a round-trip.
      store.closeTab(id)
    } else {
      store.focusAgentTab(id, chatId)
    }
  })
}

/** Open a URL in a browser tab in the right panel. */
export function openInBrowser(url: string): void {
  usePanelStore.getState().openBrowser(url)
}

/** Spawn a pi TUI terminal tab running a built-in slash command. */
export async function openPiTerminal(
  cwd: string,
  command: string,
  args: string,
  sessionPath?: string
): Promise<void> {
  const runtime = await window.piDesktop.runtime.command()
  const argv = sessionPath
    ? [runtime.command, ...runtime.args, '--session', sessionPath]
    : [runtime.command, ...runtime.args, '--no-session']
  const input = args ? `/${command} ${args}\r` : `/${command}\r`
  usePanelStore.getState().openTerminal(
    { cwd, argv, profile: 'pi', initialInput: input },
    `pi /${command}`
  )
}
