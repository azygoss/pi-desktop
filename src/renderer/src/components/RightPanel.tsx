import { Plus, TerminalSquare, X } from 'lucide-react'
import clsx from 'clsx'

import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { usePanelStore } from '../state/panel-store'
import { TerminalView } from './TerminalView'

/**
 * Right-side panel. Terminal tabs for now; browser and diff tabs join in the
 * next phase. Hidden tabs keep running (rendered offscreen for xterm).
 */
export function RightPanel() {
  const open = usePanelStore((s) => s.open)
  const tabs = usePanelStore((s) => s.tabs)
  const activeTabId = usePanelStore((s) => s.activeTabId)
  const view = useAppStore((s) => s.view)
  const workspaceDir = useAppStore((s) => s.appInfo?.workspaceDir ?? '')
  const chat = useChatStore((s) => (view.kind === 'chat' ? s.chats[view.chatId] : undefined))

  if (!open) {
    return null
  }

  const cwd = chat?.cwd || workspaceDir || '/'

  return (
    <aside className="right-panel">
      <div className="panel-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={clsx('panel-tab', { 'is-active': tab.id === activeTabId })}
            onClick={() => usePanelStore.getState().activate(tab.id)}
            title={tab.title}
          >
            <TerminalSquare size={13} />
            <span className="panel-tab-label">{tab.title}</span>
            <span
              role="button"
              className="panel-tab-close"
              title="Close"
              onClick={(e) => {
                e.stopPropagation()
                usePanelStore.getState().closeTab(tab.id)
              }}
            >
              <X size={11} />
            </span>
          </button>
        ))}
        <button
          type="button"
          className="icon-btn panel-tab-add"
          title="New terminal"
          onClick={() => usePanelStore.getState().openTerminal({ cwd }, 'Terminal')}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="panel-body">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={clsx('panel-tab-content', { 'is-active': tab.id === activeTabId })}
          >
            <TerminalView tab={tab} />
          </div>
        ))}
        {tabs.length === 0 && <div className="panel-empty">No terminals</div>}
      </div>
    </aside>
  )
}
