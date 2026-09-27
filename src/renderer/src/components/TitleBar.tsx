import { ChevronLeft, ChevronRight, MoreHorizontal, PanelLeft, PanelRight } from 'lucide-react'
import { useState } from 'react'

import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { usePanelStore } from '../state/panel-store'

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
  const workspaceDir = useAppStore((s) => s.appInfo?.workspaceDir ?? '')
  const chat = useChatStore((s) => (view.kind === 'chat' ? s.chats[view.chatId] : undefined))
  const navigate = useAppStore((s) => s.navigate)
  const panelOpen = usePanelStore((s) => s.open)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')

  // Project-less chats run in the app scratch dir — show no project label.
  const cwdBase =
    chat?.cwd && chat.cwd !== '/' && chat.cwd !== workspaceDir
      ? (chat.cwd.split('/').filter(Boolean).pop() ?? chat.cwd)
      : null

  function startRename(): void {
    if (!chat) {
      return
    }
    setRenameValue(chat.title)
    setRenaming(true)
  }

  async function commitRename(): Promise<void> {
    setRenaming(false)
    if (!chat) {
      return
    }
    const name = renameValue.trim()
    if (!name || name === chat.title) {
      return
    }
    try {
      await window.piDesktop.chat.setSessionName({ chatId: chat.chatId, name })
      useChatStore.getState().setChatTitle(chat.chatId, name)
      if (chat.sessionPath) {
        useAppStore.getState().renameSession(chat.sessionPath, name)
      }
    } catch {
      // pi rejected the rename; keep the old title
    }
  }

  async function chatMenu(): Promise<void> {
    if (!chat) {
      return
    }
    const action = await window.piDesktop.chat
      .showMenu({ chatId: chat.chatId })
      .catch(() => null)
    const sessionPath = chat.sessionPath
    switch (action) {
      case 'rename':
        startRename()
        break
      case 'export': {
        const base = chat.title.replace(/[^\w\s-]+/g, '').trim().slice(0, 60) || 'chat'
        const outputPath = await window.piDesktop.app.saveFile({
          defaultPath: `${base}.html`,
          extension: 'html'
        })
        if (outputPath) {
          await window.piDesktop.chat
            .exportHtml({ chatId: chat.chatId, outputPath })
            .catch(() => {})
        }
        break
      }
      case 'clone':
        await useChatStore.getState().cloneChat(chat.chatId).catch(() => {})
        break
      case 'reveal':
        if (sessionPath) {
          void window.piDesktop.app.revealPath(sessionPath)
        }
        break
      case 'delete': {
        if (!sessionPath) {
          break
        }
        const choice = await window.piDesktop.app.confirmDialog({
          title: 'Move this chat to Trash?',
          message: chat.title,
          buttons: ['Move to Trash', 'Cancel'],
          danger: true
        })
        if (choice === 0) {
          await window.piDesktop.sessions
            .delete({ sessionPath })
            .catch(() => {})
          void useChatStore.getState().closeChat(chat.chatId)
          navigate({ kind: 'home' })
          void useAppStore.getState().refreshSessions()
        }
        break
      }
    }
  }

  return (
    <div className="main-topbar drag-region">
      {sidebarCollapsed && <NavButtons />}
      {view.kind === 'chat' && chat && (
        <div className="chat-topbar-inner no-drag">
          {renaming ? (
            <input
              className="chat-title-input"
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void commitRename()
                } else if (e.key === 'Escape') {
                  setRenaming(false)
                }
              }}
              spellCheck={false}
            />
          ) : (
            <span className="chat-title">{chat.title}</span>
          )}
          {cwdBase && <span className="chat-cwd">{cwdBase}</span>}
          <button
            type="button"
            className="icon-btn chat-menu-btn"
            title="Chat actions"
            onClick={() => void chatMenu()}
          >
            <MoreHorizontal size={15} />
          </button>
        </div>
      )}
      <button
        type="button"
        className="icon-btn panel-toggle no-drag"
        title={panelOpen ? 'Hide panel (⌘⌥B)' : 'Show panel (⌘⌥B)'}
        onClick={() => usePanelStore.getState().togglePanel()}
      >
        <PanelRight size={16} />
      </button>
    </div>
  )
}
