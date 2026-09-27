import { Bot, FileDiff, Globe, Plus, TerminalSquare, X } from 'lucide-react'
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import clsx from 'clsx'

import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { usePanelStore, type PanelTab } from '../state/panel-store'
import { BrowserTab, NewTabPage } from './BrowserTab'
import { DiffPanel } from './DiffPanel'
import { TerminalView } from './TerminalView'

function tabIcon(tab: PanelTab): ReactNode {
  switch (tab.kind) {
    case 'browser':
      // Agent-owned tabs always carry the bot badge, never the favicon —
      // a page favicon would make them indistinguishable from user tabs.
      if (tab.agentChatId) {
        return <Bot size={13} className="panel-tab-bot" />
      }
      if (tab.favicon) {
        return <img className="panel-tab-favicon" src={tab.favicon} alt="" />
      }
      return <Globe size={13} />
    case 'terminal':
      return <TerminalSquare size={13} />
    case 'diff':
      return <FileDiff size={13} />
    case 'newtab':
      return <Plus size={13} />
  }
}

function tabTitle(tab: PanelTab): string {
  if (tab.kind === 'browser' && tab.agentChatId) {
    // Before the first navigation the stored title is just 'Pi'.
    return tab.title && tab.title !== 'Pi' && tab.title !== 'New Tab'
      ? `Pi · ${tab.title}`
      : 'Pi'
  }
  switch (tab.kind) {
    case 'diff':
      return 'Diff'
    case 'newtab':
      return 'New Tab'
    default:
      return tab.title
  }
}

/** Tooltip text: full URL for browser tabs, title for the rest. */
function tabTooltip(tab: PanelTab): string {
  return tab.kind === 'browser' && tab.url ? tab.url : tabTitle(tab)
}

function isAgentTab(tab: PanelTab): boolean {
  return tab.kind === 'browser' && tab.agentChatId !== undefined
}

/**
 * Track horizontal overflow on the tab strip: sets data attributes used for
 * the edge fades, and keeps the active tab scrolled into view.
 */
function useTabStripScroll(activeTabId: string | null, tabCount: number) {
  const stripRef = useRef<HTMLDivElement | null>(null)

  const updateFades = useCallback(() => {
    const el = stripRef.current
    if (!el) {
      return
    }
    el.dataset['fadeLeft'] = el.scrollLeft > 1 ? 'on' : 'off'
    el.dataset['fadeRight'] =
      el.scrollLeft + el.clientWidth < el.scrollWidth - 1 ? 'on' : 'off'
  }, [])

  // Vertical wheel scrolls the strip horizontally.
  const onWheel = useCallback((e: React.WheelEvent) => {
    const el = stripRef.current
    if (!el || el.scrollWidth <= el.clientWidth) {
      return
    }
    const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
    el.scrollLeft += delta
    e.preventDefault()
  }, [])

  useEffect(() => {
    const el = stripRef.current
    if (!el) {
      return
    }
    updateFades()
    const observer = new ResizeObserver(updateFades)
    observer.observe(el)
    el.addEventListener('scroll', updateFades, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', updateFades)
    }
  }, [updateFades, tabCount])

  // Keep the active tab visible when it changes or the tab list shifts.
  useEffect(() => {
    const el = stripRef.current
    const active = el?.querySelector('.panel-tab.is-active')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    updateFades()
  }, [activeTabId, tabCount, updateFades])

  return { stripRef, onWheel }
}

/**
 * Right-side panel: browser tabs, terminal tabs and one diff tab. Hidden
 * tabs keep running (rendered with visibility:hidden so xterm survives).
 */
export function RightPanel() {
  const open = usePanelStore((s) => s.open)
  const width = usePanelStore((s) => s.width)
  const tabs = usePanelStore((s) => s.tabs)
  const activeTabId = usePanelStore((s) => s.activeTabId)
  const view = useAppStore((s) => s.view)
  const workspaceDir = useAppStore((s) => s.appInfo?.workspaceDir ?? '')
  const chat = useChatStore((s) => (view.kind === 'chat' ? s.chats[view.chatId] : undefined))
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null)

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      dragState.current = { startX: e.clientX, startWidth: usePanelStore.getState().width }
      const target = e.currentTarget as HTMLElement
      target.setPointerCapture(e.pointerId)
    },
    []
  )
  const onResizeMove = useCallback((e: React.PointerEvent) => {
    const drag = dragState.current
    if (!drag) {
      return
    }
    // Panel is on the right edge: dragging left grows it.
    usePanelStore.getState().setWidth(drag.startWidth + (drag.startX - e.clientX))
  }, [])
  const onResizeEnd = useCallback(() => {
    dragState.current = null
  }, [])

  const { stripRef, onWheel } = useTabStripScroll(activeTabId, tabs.length)

  if (!open) {
    return null
  }

  const cwd = chat?.cwd || workspaceDir || '/'
  const store = usePanelStore.getState()

  return (
    <aside className="right-panel" style={{ width }}>
      <div
        className="panel-resize-handle"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
      />
      <div className="panel-tabs-wrap">
        <div className="panel-tabs" ref={stripRef} onWheel={onWheel}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={clsx('panel-tab', {
                'is-active': tab.id === activeTabId,
                'panel-tab-agent': isAgentTab(tab)
              })}
              onClick={() => store.activate(tab.id)}
              title={tabTooltip(tab)}
            >
              {tabIcon(tab)}
              <span className="panel-tab-label">{tabTitle(tab)}</span>
              {tab.kind === 'browser' && tab.loading && <span className="browser-loading" />}
              <span
                role="button"
                className="panel-tab-close"
                title="Close"
                onClick={(e) => {
                  e.stopPropagation()
                  store.closeTab(tab.id)
                }}
              >
                <X size={11} />
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn panel-tab-add"
          title="New tab"
          onClick={() => store.addNewTab()}
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
            {tab.kind === 'terminal' && <TerminalView tab={tab} />}
            {tab.kind === 'browser' && (
              <BrowserTab tab={tab} active={open && tab.id === activeTabId} />
            )}
            {tab.kind === 'diff' && <DiffPanel active={open && tab.id === activeTabId} />}
            {tab.kind === 'newtab' && (
              <NewTabPage
                onNavigate={(url) => store.convertNewTab(tab.id, url)}
                onTerminal={() => {
                  store.closeTab(tab.id)
                  store.openTerminal({ cwd }, 'Terminal')
                }}
                onDiff={() => {
                  store.closeTab(tab.id)
                  store.openDiff()
                }}
              />
            )}
          </div>
        ))}
        {tabs.length === 0 && (
          <NewTabPage
            onNavigate={(url) => store.openBrowser(url)}
            onTerminal={() => store.openTerminal({ cwd }, 'Terminal')}
            onDiff={() => store.openDiff()}
          />
        )}
      </div>
    </aside>
  )
}
