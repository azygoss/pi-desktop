import { useEffect } from 'react'

import { ChatView } from './components/ChatView'
import { CommandModals } from './components/CommandModals'
import { HomeView } from './components/HomeView'
import { RightPanel } from './components/RightPanel'
import { SettingsModal } from './components/SettingsModal'
import { Sidebar } from './components/Sidebar'
import { MainTopBar } from './components/TitleBar'
import { Toasts } from './components/Toasts'
import { useAppStore } from './state/app-store'
import { initChatBridge, useChatStore } from './state/chat-store'
import { initPanelBridge, usePanelStore } from './state/panel-store'

export function App() {
  const view = useAppStore((s) => s.view)
  const ready = useAppStore((s) => s.ready)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const settingsOpen = useAppStore((s) => s.settingsOpen)

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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const store = useAppStore.getState()
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
      <RightPanel />
      {settingsOpen && <SettingsModal />}
      <CommandModals />
      <Toasts />
    </div>
  )
}
