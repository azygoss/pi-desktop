import {
  Archive,
  ClipboardCopy,
  Clock,
  FileDiff,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  MessageCircleQuestion,
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

import type { SessionSearchHit } from '../../../shared/api'
import type { SessionSummary } from '../../../shared/session-types'
import { chatToMarkdown } from '../lib/chat-markdown'
import { fuzzyScore } from '../lib/fuzzy'
import { newChatInWorktree } from '../lib/worktree-actions'
import { toast } from '../state/toast-store'
import { archiveSessionPath, setSessionArchived, setSessionPinned } from '../lib/session-actions'
import { useAppStore } from '../state/app-store'
import { useChatStore, type ChatState } from '../state/chat-store'
import { usePanelStore } from '../state/panel-store'
import { newChatInProject, openSession } from './Sidebar'
import { ProjectSigil, ScratchSigil } from './Pixels'

interface PaletteItem {
  id: string
  section: string
  title: string
  /** Second line under the title (a search excerpt). */
  subtitle?: string
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
  projects: { cwd: string; name: string; worktree?: boolean }[],
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
      project ? <ProjectSigil seed={session.cwd} size={12} /> : <ScratchSigil size={12} />,
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
  add('Actions', <GitPullRequest size={13} />, 'Open pull request', () =>
    usePanelStore.getState().openPr()
  )
  if (chatId) {
    add(
      'Actions',
      <Search size={13} />,
      'Find in chat',
      () => window.dispatchEvent(new CustomEvent('pi-desktop:find-in-chat')),
      '⌘F'
    )
  }
  if (chatId) {
    add(
      'Actions',
      <MessageCircleQuestion size={13} />,
      'Ask a side question',
      () => usePanelStore.getState().openSide(chatId),
      '⌘;'
    )
    add('Actions', <ClipboardCopy size={13} />, 'Copy chat as Markdown', () => {
      const current = useChatStore.getState().chats[chatId]
      if (!current || current.messages.length === 0) {
        toast('Nothing to copy yet')
        return
      }
      void navigator.clipboard
        .writeText(
          chatToMarkdown(current.title, current.messages, current.toolRuns, current.cwd)
        )
        .then(() => toast('Copied chat as Markdown'))
        .catch(() => toast('Copy failed'))
    })
    const chatCwd = useChatStore.getState().chats[chatId]?.cwd
    if (chatCwd && chatCwd !== workspaceDir) {
      add('Actions', <FolderOpen size={13} />, 'Open project in…', () => {
        void window.piDesktop.app.openInMenu({ cwd: chatCwd }).catch(() => {})
      })
    }
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
  add('Actions', <Clock size={13} />, 'Automations', () => app.setAutomationsOpen(true))
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
      <ProjectSigil seed={project.cwd} size={12} />,
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
  for (const project of projects) {
    if (project.worktree) {
      continue
    }
    add(
      'Projects',
      <GitBranch size={13} />,
      `New worktree chat in ${project.name}`,
      () => void newChatInWorktree(project.cwd),
      undefined,
      `worktree ${project.name} ${project.cwd}`
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

  // Full-text search over conversations, debounced; main cancels a scan
  // when a newer query arrives. Hits are kept with the query they answer
  // so a stale result never shows under a different query.
  const [contentHits, setContentHits] = useState<{ query: string; hits: SessionSearchHit[] }>({
    query: '',
    hits: []
  })
  useEffect(() => {
    const q = query.trim()
    if (q.length < 3) {
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void window.piDesktop.sessions
        .search({ query: q })
        .then((hits) => {
          if (!cancelled) {
            setContentHits({ query: q, hits })
          }
        })
        .catch(() => {})
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const items = useMemo(() => {
    const base = buildItems(query, sessions, projects, chatId, chat, workspaceDir)
    const q = query.trim()
    if (q.length < 3 || contentHits.query !== q) {
      return base
    }
    const byPath = new Map(sessions.map((s) => [s.path, s]))
    const found: PaletteItem[] = []
    for (const hit of contentHits.hits) {
      const session = byPath.get(hit.sessionPath)
      if (!session) {
        continue
      }
      const project = projectName(session.cwd, workspaceDir)
      found.push({
        id: `content:${hit.sessionPath}`,
        section: 'In conversations',
        title: session.title,
        subtitle: hit.snippet,
        hint: hit.matches > 1 ? `${hit.matches} matches` : (project ?? undefined),
        icon: project ? (
          <ProjectSigil seed={session.cwd} size={12} />
        ) : (
          <ScratchSigil size={12} />
        ),
        run: () => {
          openSession(session)
          // Land on the match: open find-in-chat with the query once the
          // chat view has mounted.
          setTimeout(
            () =>
              window.dispatchEvent(
                new CustomEvent('pi-desktop:find-in-chat', { detail: { query: q } })
              ),
            350
          )
        }
      })
    }
    return [...base, ...found]
  }, [query, sessions, projects, chatId, chat, workspaceDir, contentHits])

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
            placeholder="Search chats, conversations, projects, actions…"
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
                {row.item.subtitle ? (
                  <span className="palette-row-text">
                    <span className="palette-row-title">{row.item.title}</span>
                    <span className="palette-row-subtitle">{row.item.subtitle}</span>
                  </span>
                ) : (
                  <span className="palette-row-title">{row.item.title}</span>
                )}
                {row.item.hint && <span className="palette-row-hint">{row.item.hint}</span>}
              </button>
            )
          )}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span>
            <kbd>↑↓</kbd>navigate
          </span>
          <span>
            <kbd>↵</kbd>open
          </span>
          <span>
            <kbd>esc</kbd>close
          </span>
        </div>
      </div>
    </div>
  )
}
