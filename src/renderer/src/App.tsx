import { Suspense, lazy, useEffect, useState } from 'react'

import { ChatView } from './components/ChatView'
import { HomeView } from './components/HomeView'
import { Sidebar } from './components/Sidebar'
import { MainTopBar } from './components/TitleBar'
import { Toasts } from './components/Toasts'
import { Lightbox } from './components/Lightbox'
import { nextOpenChat } from './lib/chat-cycle'
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
const CommandPalette = lazy(() =>
  import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette }))
)

export function App() {
  const view = useAppStore((s) => s.view)
  const ready = useAppStore((s) => s.ready)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const chatModal = useAppStore((s) => s.chatModal)
  const paletteOpen = useAppStore((s) => s.paletteOpen)
  const lightboxOpen = useAppStore((s) => s.lightbox !== null)
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
      } else if (action === 'find-in-chat') {
        if (store.view.kind === 'chat') {
          window.dispatchEvent(new CustomEvent('pi-desktop:find-in-chat'))
        }
      }
    })
    const unsubscribeOpenChat = window.piDesktop.app.onOpenChat(({ chatId }) => {
      if (useChatStore.getState().chats[chatId]) {
        useAppStore.getState().navigate({ kind: 'chat', chatId })
      }
    })
    // Dock badge: unread chats + chats with a pending interactive request.
    let lastBadge = -1
    const updateBadge = () => {
      const enabled =
        useAppStore.getState().appSettings.notifications?.enabled !== false
      const count = enabled
        ? Object.values(useChatStore.getState().chats).filter(
            (c) =>
              c.unread ||
              (c.uiRequest &&
                (c.uiRequest.method === 'confirm' ||
                  c.uiRequest.method === 'select' ||
                  c.uiRequest.method === 'input' ||
                  c.uiRequest.method === 'editor'))
          ).length
        : 0
      if (count !== lastBadge) {
        lastBadge = count
        void window.piDesktop.app.setBadge(count).catch(() => {})
      }
    }
    const unsubscribeBadge = useChatStore.subscribe(updateBadge)
    const unsubscribeBadgeSettings = useAppStore.subscribe(updateBadge)
    return () => {
      unsubscribe()
      unsubscribeMenu()
      unsubscribeOpenChat()
      unsubscribeBadge()
      unsubscribeBadgeSettings()
    }
  }, [])

  // Seed the panel from persisted settings once app settings are loaded.
  const hydratedPanel = usePanelStore((s) => s.hydrated)
  useEffect(() => {
    if (ready && !hydratedPanel) {
      const s = useAppStore.getState().appSettings
      usePanelStore.getState().hydrate(s.panelOpen, s.panelWidth, s.recentUrls)
    }
  }, [ready, hydratedPanel])

  // Keep the panel mounted briefly while its close animation plays out.
  const [panelMounted, setPanelMounted] = useState(panelOpen)
  if (panelOpen && !panelMounted) {
    setPanelMounted(true) // render-time adjust: opening mounts immediately
  }
  useEffect(() => {
    if (panelOpen) {
      return
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = setTimeout(() => setPanelMounted(false), reduced ? 0 : 200)
    return () => clearTimeout(timer)
  }, [panelOpen])

  // Keep browser views hidden whenever no browser tab is on screen.
  useEffect(() => {
    if (!browserActive) {
      void window.piDesktop.browser.setVisible({ id: null }).catch(() => {})
    }
  }, [browserActive, panelOpen])

  // DOM overlays must never be painted over by a browser view.
  useEffect(() => {
    const overlay = settingsOpen || chatModal !== null || paletteOpen || lightboxOpen
    void window.piDesktop.browser.setOverlayOpen({ open: overlay }).catch(() => {})
  }, [settingsOpen, chatModal, paletteOpen, lightboxOpen])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const store = useAppStore.getState()
      // ⌘⌥B toggles the right panel (⌥ may change e.key on macOS).
      if (e.metaKey && e.altKey && e.code === 'KeyB') {
        e.preventDefault()
        usePanelStore.getState().togglePanel()
        return
      }
      // ⌘L: focus the new-tab page's omnibox (opens a tab when needed).
      if (e.metaKey && e.key === 'l' && usePanelStore.getState().open) {
        e.preventDefault()
        const panel = usePanelStore.getState()
        const omnibox = document.querySelector<HTMLInputElement>(
          '.panel-tab-content.is-active .newtab-omnibox input'
        )
        if (omnibox) {
          omnibox.focus()
          omnibox.select()
        } else {
          panel.addNewTab()
          setTimeout(
            () =>
              document
                .querySelector<HTMLInputElement>('.newtab-omnibox input')
                ?.focus(),
            50
          )
        }
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
      // ⌃Tab / ⌃⇧Tab: cycle through the chats that are open in this window.
      if (e.ctrlKey && !e.metaKey && e.key === 'Tab') {
        e.preventDefault()
        const next = nextOpenChat(
          Object.values(useChatStore.getState().chats)
            .filter((c) => c.messages.length > 0)
            .map((c) => c.chatId),
          store.view.kind === 'chat' ? store.view.chatId : null,
          e.shiftKey ? -1 : 1
        )
        if (next) {
          store.navigate({ kind: 'chat', chatId: next })
        }
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
        if (!e.shiftKey) {
          e.preventDefault()
          store.toggleSidebar()
        }
      } else if (e.key === 'n' && !e.shiftKey) {
        e.preventDefault()
        store.navigate({ kind: 'home' })
      } else if (e.key === 'k' && !e.shiftKey) {
        e.preventDefault()
        store.setPaletteOpen(!store.paletteOpen)
      } else if (e.key === 'F' && e.shiftKey) {
        // ⌘⇧F — inline filter inside the sidebar (⌘K is the palette).
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
    <div className={ready && !sidebarCollapsed ? 'app-shell' : 'app-shell sidebar-hidden'}>
      {ready && !sidebarCollapsed && <Sidebar />}
      <main className="main-pane">
        <MainTopBar />
        {ready && (view.kind === 'home' ? <HomeView /> : <ChatView chatId={view.chatId} />)}
      </main>
      {panelMounted && (
        <Suspense fallback={null}>
          <RightPanel closing={!panelOpen} />
        </Suspense>
      )}
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette />
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
      <Lightbox />
      <Toasts />
    </div>
  )
}
