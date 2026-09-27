import { create } from 'zustand'

import type { TerminalProfile } from '../../../shared/api'

export interface TerminalTabSpec {
  cwd: string
  /** Empty/omitted → login shell. */
  argv?: string[]
  profile?: TerminalProfile
  initialInput?: string
}

export interface PanelTab {
  id: string
  kind: 'terminal'
  title: string
  spec: TerminalTabSpec
  /** Set once the pty spawned; cleared on exit. */
  exited?: boolean
}

interface PanelState {
  open: boolean
  tabs: PanelTab[]
  activeTabId: string | null

  setOpen(open: boolean): void
  openTerminal(spec: TerminalTabSpec, title: string): string
  /** Focus an existing terminal tab or create a fresh shell terminal. */
  toggleTerminal(cwd: string): void
  activate(id: string): void
  closeTab(id: string): void
  markExited(id: string): void
}

export const usePanelStore = create<PanelState>((set, get) => ({
  open: false,
  tabs: [],
  activeTabId: null,

  setOpen(open) {
    set({ open })
  },

  openTerminal(spec, title) {
    const id = crypto.randomUUID()
    set((s) => ({
      open: true,
      tabs: [...s.tabs, { id, kind: 'terminal', title, spec }],
      activeTabId: id
    }))
    return id
  },

  toggleTerminal(cwd) {
    const { tabs, open, activeTabId } = get()
    const existing = tabs.find((t) => t.kind === 'terminal' && !t.exited)
    if (!open) {
      set({ open: true, activeTabId: existing?.id ?? activeTabId })
      if (!existing) {
        get().openTerminal({ cwd }, 'Terminal')
      }
      return
    }
    if (!existing) {
      get().openTerminal({ cwd }, 'Terminal')
      return
    }
    // Panel open with a terminal: a second press toggles the panel closed.
    set({ open: false })
  },

  activate(id) {
    set({ activeTabId: id, open: true })
  },

  closeTab(id) {
    void window.piDesktop.terminal.kill({ id }).catch(() => {})
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTabId =
        s.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId
      return { tabs, activeTabId, open: tabs.length === 0 ? false : s.open }
    })
  },

  markExited(id) {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, exited: true } : t))
    }))
  }
}))

/** Wire pty exit events → tab state once per session. */
let ptyBridgeReady = false
export function initPanelBridge(): void {
  if (ptyBridgeReady) {
    return
  }
  ptyBridgeReady = true
  window.piDesktop.terminal.onExit(({ id }) => {
    usePanelStore.getState().markExited(id)
  })
}

/**
 * Open a URL — until the in-app browser panel (section D) exists, this falls
 * back to the system browser.
 */
export function openInBrowser(url: string): void {
  void window.piDesktop.app.openExternal(url).catch(() => {})
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
