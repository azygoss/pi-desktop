import { Suspense, lazy, useEffect } from 'react'

import { ChatView } from './components/ChatView'
import { HomeView } from './components/HomeView'
import { Sidebar } from './components/Sidebar'
import { MainTopBar } from './components/TitleBar'
import { Toasts } from './components/Toasts'
import { useAppStore } from './state/app-store'
import { initChatBridge, useChatStore } from './state/chat-store'
import { initPanelBridge, usePanelStore } from './state/panel-store'

// Heavy surfaces (xterm, diff parser, settings, command modals) load on
// demand so the main renderer chunk stays small.
const RightPanel = lazy(() =>
  import('./components/RightPanel').then((m) => ({ default: m.RightPanel }))
)
const SettingsModal = lazy(() =>
  import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal }))
)
const CommandModals = lazy(() =>
  import('./components/CommandModals').then((m) => ({ default: m.CommandModals }))
)

export function App() {
  const view = useAppStore((s) => s.view)
  const ready = useAppStore((s) => s.ready)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const chatModal = useAppStore((s) => s.chatModal)
  const panelOpen = usePanelStore((s) => s.open)
  const browserActive = usePanelStore(
    (s) => s.open && s.tabs.find((t) => t.id === s.activeTabId)?.kind === 'browser'
  )

  useEffect(() => {
    initChatBridge()
    initPanelBridge()
    void useAppStore.getState().init()
    const unsubscribe = window.piDesktop.sessions.onChanged(() => {
      void useAppStore.getState().refreshSessions()
    })
    const unsubscribeMenu = window.piDesktop.app.onMenuAction((action) => {
      const store = useAppStore.getState()
      if (action === 'open-settings') {
        store.openSettings()
      } else if (action === 'toggle-sidebar') {
        store.toggleSidebar()
      } else if (action === 'new-chat') {
        store.navigate({ kind: 'home' })
      }
    })
    return () => {
      unsubscribe()
      unsubscribeMenu()
    }
  }, [])

  // Seed the panel from persisted settings once app settings are loaded.
  const hydratedPanel = usePanelStore((s) => s.hydrated)
  useEffect(() => {
    if (ready && !hydratedPanel) {
      const s = useAppStore.getState().appSettings
      usePanelStore.getState().hydrate(s.panelOpen, s.panelWidth)
    }
  }, [ready, hydratedPanel])

  // Keep browser views hidden whenever no browser tab is on screen.
  useEffect(() => {
    if (!browserActive) {
      void window.piDesktop.browser.setVisible({ id: null }).catch(() => {})
    }
  }, [browserActive, panelOpen])

  // DOM overlays must never be painted over by a browser view.
  useEffect(() => {
    const overlay = settingsOpen || chatModal !== null
    void window.piDesktop.browser.setOverlayOpen({ open: overlay }).catch(() => {})
  }, [settingsOpen, chatModal])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const store = useAppStore.getState()
      // ⌘⌥B toggles the right panel (⌥ may change e.key on macOS).
      if (e.metaKey && e.altKey && e.code === 'KeyB') {
        e.preventDefault()
        usePanelStore.getState().togglePanel()
        return
      }
      // ⌃` toggles/creates a terminal (ctrl-only, no meta).
      if (e.key === '`' && e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        const view = store.view
        const chat =
          view.kind === 'chat' ? useChatStore.getState().chats[view.chatId] : undefined
        const cwd = chat?.cwd || store.appInfo?.workspaceDir || '/'
        usePanelStore.getState().toggleTerminal(cwd)
        return
      }
      if (!e.metaKey && !e.ctrlKey) {
        return
      }
      if (e.key === '[') {
        e.preventDefault()
        store.goBack()
      } else if (e.key === ']') {
        e.preventDefault()
        store.goForward()
      } else if (e.key === 'b' || e.key === '\\') {
        e.preventDefault()
        store.toggleSidebar()
      } else if (e.key === 'n') {
        e.preventDefault()
        store.navigate({ kind: 'home' })
      } else if (e.key === 'k') {
        e.preventDefault()
        if (store.sidebarCollapsed) {
          store.toggleSidebar()
        }
        store.setSidebarSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="app-shell">
      {ready && !sidebarCollapsed && <Sidebar />}
      <main className="main-pane">
        <MainTopBar />
        {ready && (view.kind === 'home' ? <HomeView /> : <ChatView chatId={view.chatId} />)}
      </main>
      {panelOpen && (
        <Suspense fallback={null}>
          <RightPanel />
        </Suspense>
      )}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <CommandModals />
      </Suspense>
      <Toasts />
    </div>
  )
}
