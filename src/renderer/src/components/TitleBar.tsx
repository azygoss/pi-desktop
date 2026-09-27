import { ChevronLeft, ChevronRight, PanelLeft } from 'lucide-react'

import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'

/**
 * Navigation buttons that live in the 44px window drag strip: sidebar toggle
 * plus back/forward. Rendered inside the sidebar's own top row when the
 * sidebar is expanded, and inside the main pane's top row when it is hidden.
 */
export function NavButtons() {
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const backStack = useAppStore((s) => s.backStack)
  const forwardStack = useAppStore((s) => s.forwardStack)
  const goBack = useAppStore((s) => s.goBack)
  const goForward = useAppStore((s) => s.goForward)

  return (
    <div className="nav-buttons">
      <button
        type="button"
        className="icon-btn"
        onClick={toggleSidebar}
        title={sidebarCollapsed ? 'Show sidebar (⌘B)' : 'Hide sidebar (⌘B)'}
      >
        <PanelLeft size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={goBack}
        disabled={backStack.length === 0}
        title="Back (⌘[)"
      >
        <ChevronLeft size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={goForward}
        disabled={forwardStack.length === 0}
        title="Forward (⌘])"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  )
}

/**
 * The main pane's 44px drag strip. When the sidebar is hidden it carries the
 * nav buttons (offset past the traffic lights); in chat view it shows the
 * chat title and cwd basename.
 */
export function MainTopBar() {
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const view = useAppStore((s) => s.view)
  const chat = useChatStore((s) => (view.kind === 'chat' ? s.chats[view.chatId] : undefined))

  const cwdBase =
    chat?.cwd && chat.cwd !== '/'
      ? (chat.cwd.split('/').filter(Boolean).pop() ?? chat.cwd)
      : null

  return (
    <div className="main-topbar drag-region">
      {sidebarCollapsed && <NavButtons />}
      {view.kind === 'chat' && chat && (
        <div className="chat-topbar-inner no-drag">
          <span className="chat-title">{chat.title}</span>
          {cwdBase && <span className="chat-cwd">{cwdBase}</span>}
        </div>
      )}
    </div>
  )
}
