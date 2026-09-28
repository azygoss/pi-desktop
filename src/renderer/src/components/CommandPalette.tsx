import {
  Archive,
  FileDiff,
  Folder,
  MessageSquare,
  Pin,
  PanelLeft,
  PanelRight,
  Plus,
  RotateCcw,
  Search,
  Settings,
  SquareTerminal,
  SunMoon,
  Zap
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import clsx from 'clsx'

import type { SessionSummary } from '../../../shared/session-types'
import { fuzzyScore } from '../lib/fuzzy'
import { archiveSessionPath, setSessionArchived, setSessionPinned } from '../lib/session-actions'
import { useAppStore } from '../state/app-store'
import { useChatStore, type ChatState } from '../state/chat-store'
import { usePanelStore } from '../state/panel-store'
import { newChatInProject, openSession } from './Sidebar'

interface PaletteItem {
  id: string
  section: string
  title: string
  /** Right-aligned keyboard hint or subtitle. */
  hint?: string
  icon: ReactNode
  run: () => void
}

function projectName(cwd: string, workspaceDir: string): string | null {
  if (!cwd || cwd === workspaceDir) {
    return null
  }
  return cwd.split('/').filter(Boolean).pop() ?? null
}

function buildItems(
  query: string,
  sessions: SessionSummary[],
  projects: { cwd: string; name: string }[],
  chatId: string | null,
  chat: Pick<ChatState, 'models' | 'commands' | 'model' | 'status' | 'sessionPath'> | undefined,
  workspaceDir: string
): PaletteItem[] {
  const app = useAppStore.getState()
  const scored: { item: PaletteItem; score: number; order: number }[] = []
  let order = 0
  const add = (
    section: string,
    icon: ReactNode,
    title: string,
    run: () => void,
    hint?: string,
    searchText?: string
  ) => {
    const score = fuzzyScore(query, searchText ?? title)
    order += 1
    if (score >= 0) {
      scored.push({
        item: { id: `${section}:${order}`, section, title, hint, icon, run },
        score,
        order
      })
    }
  }

  // Chats — sessions are already sorted newest-first, so an empty query
  // naturally surfaces the most recent ones.
  for (const session of sessions.slice(0, 60)) {
    const project = projectName(session.cwd, workspaceDir)
    add(
      'Chats',
      <MessageSquare size={13} />,
      session.title,
      () => openSession(session),
      project ?? undefined
    )
  }

  // Actions
  add('Actions', <Plus size={13} />, 'New chat', () => app.navigate({ kind: 'home' }), '⌘N')
  add('Actions', <PanelLeft size={13} />, 'Toggle sidebar', () => app.toggleSidebar(), '⌘B')
  add('Actions', <PanelRight size={13} />, 'Toggle panel', () => usePanelStore.getState().togglePanel(), '⌘⌥B')
  add('Actions', <SquareTerminal size={13} />, 'Open terminal', () => {
    const cwd =
      (chatId ? useChatStore.getState().chats[chatId]?.cwd : undefined) || workspaceDir || '/'
    usePanelStore.getState().openTerminal({ cwd }, 'Terminal')
  }, '⌃`')
  add('Actions', <FileDiff size={13} />, 'Open diff', () => usePanelStore.getState().openDiff())
  if (chatId) {
    add(
      'Actions',
      <Search size={13} />,
      'Find in chat',
      () => window.dispatchEvent(new CustomEvent('pi-desktop:find-in-chat')),
      '⌘F'
    )
  }
  if (chatId && chat?.sessionPath) {
    const sessionPath = chat.sessionPath
    const meta = useAppStore.getState().sessionMeta[sessionPath]
    if (meta?.pinned === undefined) {
      add('Actions', <Pin size={13} />, 'Pin chat', () =>
        void setSessionPinned(sessionPath, true)
      )
    } else {
      add('Actions', <Pin size={13} />, 'Unpin chat', () =>
        void setSessionPinned(sessionPath, false)
      )
    }
    if (meta?.archived === undefined) {
      add('Actions', <Archive size={13} />, 'Archive chat', () =>
        void archiveSessionPath(sessionPath)
      )
    } else {
      add('Actions', <Archive size={13} />, 'Unarchive chat', () =>
        void setSessionArchived(sessionPath, false)
      )
    }
  }
  add('Actions', <Settings size={13} />, 'Open settings', () => app.openSettings(), '⌘,')
  for (const theme of ['light', 'dark', 'system'] as const) {
    add(
      'Actions',
      <SunMoon size={13} />,
      `Theme: ${theme[0]!.toUpperCase()}${theme.slice(1)}`,
      () => void app.updateAppSettings({ theme })
    )
  }
  if (chatId) {
    add('Actions', <RotateCcw size={13} />, 'Reload pi for this chat', () => {
      void useChatStore.getState().reloadChat(chatId).catch(() => {})
    })
  }

  // Projects — picking one starts a new chat scoped to it and expands the row.
  for (const project of projects) {
    add(
      'Projects',
      <Folder size={13} />,
      `New chat in ${project.name}`,
      () => {
        const s = useAppStore.getState()
        if (!s.appSettings.expandedProjects.includes(project.cwd)) {
          s.toggleProjectExpanded(project.cwd)
        }
        newChatInProject(project.cwd)
      },
      undefined,
      `${project.name} ${project.cwd}`
    )
  }

  // Models for the current chat.
  if (chatId && chat && chat.models.length > 0) {
    for (const model of chat.models) {
      const current = chat.model?.provider === model.provider && chat.model?.id === model.id
      add(
        'Models',
        <Zap size={13} />,
        `Switch model → ${model.name}`,
        () => {
          void useChatStore.getState().setModel(chatId, model.provider, model.id)
        },
        current ? 'current' : model.provider,
        `${model.name} ${model.provider}`
      )
    }
  }

  // Slash commands known to the current chat's pi process.
  if (chatId && chat) {
    for (const command of chat.commands) {
      add(
        'Slash commands',
        <span className="palette-slash">/</span>,
        `/${command.name}`,
        () => {
          void useChatStore
            .getState()
            .send(chatId, `/${command.name}`, undefined, 'prompt')
            .catch(() => {})
        },
        command.description,
        `/${command.name} ${command.description ?? ''}`
      )
    }
  }

  // Group into sections in encounter order; sort by score within a section
  // only when filtering (empty query keeps recency/order).
  const seen = new Map<string, typeof scored>()
  for (const entry of scored) {
    const list = seen.get(entry.item.section) ?? []
    list.push(entry)
    seen.set(entry.item.section, list)
  }
  const result: PaletteItem[] = []
  for (const entries of seen.values()) {
    entries.sort((a, b) => (query.trim() ? b.score - a.score : a.order - b.order))
    for (const entry of entries) {
      result.push(entry.item)
    }
  }
  // Trim: keep lists usable — cap each section at 8 rows when not filtering.
  if (!query.trim()) {
    const counts = new Map<string, number>()
    return result.filter((item) => {
      const n = (counts.get(item.section) ?? 0) + 1
      counts.set(item.section, n)
      return item.section === 'Slash commands' ? n <= 10 : n <= 8
    })
  }
  return result
}

/** ⌘K command palette — Raycast-style centered modal over a blurred backdrop. */
export function CommandPalette() {
  const sessions = useAppStore((s) => s.sessions)
  const projects = useAppStore((s) => s.projects)
  const workspaceDir = useAppStore((s) => s.appInfo?.workspaceDir ?? '')
  const view = useAppStore((s) => s.view)
  const chatId = view.kind === 'chat' ? view.chatId : null
  const chat = useChatStore(
    useShallow((s) => {
      const c = chatId ? s.chats[chatId] : undefined
      return c
        ? {
            models: c.models,
            commands: c.commands,
            model: c.model,
            status: c.status,
            sessionPath: c.sessionPath
          }
        : undefined
    })
  )

  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo(
    () => buildItems(query, sessions, projects, chatId, chat, workspaceDir),
    [query, sessions, projects, chatId, chat, workspaceDir]
  )

  // Flatten items into header/row pairs once — no mutation during render.
  const rows = useMemo(() => {
    const out: ({ type: 'header'; label: string } | { type: 'item'; item: PaletteItem; index: number })[] = []
    let lastSection = ''
    items.forEach((item, index) => {
      if (item.section !== lastSection) {
        out.push({ type: 'header', label: item.section })
        lastSection = item.section
      }
      out.push({ type: 'item', item, index })
    })
    return out
  }, [items])

  useEffect(() => {
    listRef.current
      ?.querySelector('.palette-row.is-highlight')
      ?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  const close = () => useAppStore.getState().setPaletteOpen(false)

  function runItem(index: number): void {
    const item = items[index]
    if (!item) {
      return
    }
    close()
    item.run()
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runItem(highlight)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  return (
    <div className="palette-backdrop" onClick={close}>
      <div
        className="palette-modal"
        role="dialog"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="palette-input-row">
          <Search size={15} />
          <input
            className="palette-input"
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlight(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Search chats, projects, actions…"
            spellCheck={false}
          />
          <kbd className="kbd">esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">No results</div>}
          {rows.map((row) =>
            row.type === 'header' ? (
              <div key={`h-${row.label}`} className="palette-section">
                {row.label}
              </div>
            ) : (
              <button
                key={row.item.id}
                type="button"
                className={clsx('palette-row', { 'is-highlight': row.index === highlight })}
                onMouseEnter={() => setHighlight(row.index)}
                onClick={() => runItem(row.index)}
              >
                <span className="palette-row-icon">{row.item.icon}</span>
                <span className="palette-row-title">{row.item.title}</span>
                {row.item.hint && <span className="palette-row-hint">{row.item.hint}</span>}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  )
}
