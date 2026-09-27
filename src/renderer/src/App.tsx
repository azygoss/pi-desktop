import { useEffect } from 'react'

import { ChatView } from './components/ChatView'
import { HomeView } from './components/HomeView'
import { Sidebar } from './components/Sidebar'
import { MainTopBar } from './components/TitleBar'
import { useAppStore } from './state/app-store'
import { initChatBridge } from './state/chat-store'

export function App() {
  const view = useAppStore((s) => s.view)
  const ready = useAppStore((s) => s.ready)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)

  useEffect(() => {
    initChatBridge()
    void useAppStore.getState().init()
    const unsubscribe = window.piDesktop.sessions.onChanged(() => {
      void useAppStore.getState().refreshSessions()
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) {
        return
      }
      const store = useAppStore.getState()
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
    </div>
  )
}
