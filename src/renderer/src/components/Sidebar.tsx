import {
  ChevronDown,
  ChevronRight,
  Folder,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import clsx from 'clsx'

import type { SessionSummary } from '../../../shared/session-types'
import { groupByDate } from '../lib/date-groups'
import { capitalizeName } from '../lib/greeting'
import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { NavButtons } from './TitleBar'

const MAX_NESTED_CHATS = 3

/** Chats that run in the app scratch dir (or have no recorded cwd) are
 *  "project-less" and live in the Chats section, not under a project. */
export function isProjectless(cwd: string, workspaceDir: string): boolean {
  return cwd === workspaceDir || cwd === ''
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) {
    return ''
  }
  const diff = Date.now() - then
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) {
    return 'now'
  }
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  const days = Math.floor(hours / 24)
  if (days < 30) {
    return `${days}d`
  }
  return `${Math.floor(days / 30)}mo`
}

function isSessionActive(session: SessionSummary): boolean {
  const { view } = useAppStore.getState()
  if (view.kind !== 'chat') {
    return false
  }
  return useChatStore.getState().chats[view.chatId]?.sessionPath === session.path
}

function openSession(session: SessionSummary): void {
  const existing = useChatStore.getState().openSessionChat(session.path)
  const chatId = existing ?? crypto.randomUUID()
  if (!existing) {
    void useChatStore
      .getState()
      .ensureChat(chatId, { sessionPath: session.path })
      .catch(() => {})
  }
  useAppStore.getState().navigate({ kind: 'chat', chatId })
}

function newChatInProject(cwd: string): void {
  const chatId = crypto.randomUUID()
  void useChatStore.getState().ensureChat(chatId, { cwd }).catch(() => {})
  useAppStore.getState().navigate({ kind: 'chat', chatId })
}

async function exportSession(session: SessionSummary): Promise<void> {
  const base = session.title.replace(/[^\w\s-]+/g, '').trim().slice(0, 60) || 'chat'
  const outputPath = await window.piDesktop.app.saveFile({
    defaultPath: `${base}.html`,
    extension: 'html'
  })
  if (!outputPath) {
    return
  }
  try {
    const result = await window.piDesktop.sessions.exportHtml({
      sessionPath: session.path,
      outputPath
    })
    const choice = await window.piDesktop.app.confirmDialog({
      title: 'Chat exported',
      message: result.path ?? outputPath,
      buttons: ['Reveal', 'Done']
    })
    if (choice === 0) {
      void window.piDesktop.app.revealPath(result.path ?? outputPath)
    }
  } catch {
    // export failed; pi reported the error already
  }
}

async function deleteSession(session: SessionSummary): Promise<void> {
  const choice = await window.piDesktop.app.confirmDialog({
    title: 'Move this chat to Trash?',
    message: session.title,
    buttons: ['Move to Trash', 'Cancel'],
    danger: true
  })
  if (choice !== 0) {
    return
  }
  const wasActive = isSessionActive(session)
  const openChatId = await window.piDesktop.chat
    .chatIdForSession({ sessionPath: session.path })
    .catch(() => undefined)
  await window.piDesktop.sessions.delete({ sessionPath: session.path }).catch(() => {})
  if (openChatId && useChatStore.getState().chats[openChatId]) {
    void useChatStore.getState().closeChat(openChatId)
  }
  if (wasActive) {
    useAppStore.getState().navigate({ kind: 'home' })
  }
  void useAppStore.getState().refreshSessions()
}

interface LiveStatus {
  streaming: boolean
  unread: boolean
}

function SessionRow({
  session,
  nested,
  live
}: {
  session: SessionSummary
  nested?: boolean
  live?: LiveStatus
}) {
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const active = isSessionActive(session)

  function startRename(): void {
    setRenameValue(session.name ?? session.title)
    setRenaming(true)
  }

  async function commitRename(): Promise<void> {
    setRenaming(false)
    const name = renameValue.trim()
    if (!name) {
      return
    }
    await window.piDesktop.sessions
      .rename({ sessionPath: session.path, name })
      .catch(() => {})
    useAppStore.getState().renameSession(session.path, name)
    void useAppStore.getState().refreshSessions()
  }

  async function contextMenu(): Promise<void> {
    const action = await window.piDesktop.sessions
      .showMenu({ sessionPath: session.path })
      .catch(() => null)
    switch (action) {
      case 'rename':
        startRename()
        break
      case 'export':
        void exportSession(session)
        break
      case 'reveal':
        void window.piDesktop.app.revealPath(session.path)
        break
      case 'copy-path':
        void navigator.clipboard.writeText(session.path)
        break
      case 'delete':
        void deleteSession(session)
        break
    }
  }

  return (
    <div
      className={clsx('sidebar-item', 'sidebar-session', {
        'is-active': active,
        'sidebar-session-nested': nested
      })}
      role="button"
      tabIndex={0}
      onClick={() => openSession(session)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          openSession(session)
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void contextMenu()
      }}
    >
      {active && <span className="active-dot" />}
      {renaming ? (
        <input
          className="sidebar-rename-input"
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              void commitRename()
            } else if (e.key === 'Escape') {
              setRenaming(false)
            }
          }}
          onClick={(e) => e.stopPropagation()}
          spellCheck={false}
        />
      ) : (
        <span className="sidebar-item-label">{session.title}</span>
      )}
      {live?.streaming && <span className="live-dot" title="Working…" />}
      {!live?.streaming && live?.unread && (
        <span className="unread-dot" title="New reply" />
      )}
      <button
        type="button"
        className="icon-btn sidebar-item-more"
        title="Chat actions"
        onClick={(e) => {
          e.stopPropagation()
          void contextMenu()
        }}
      >
        <MoreHorizontal size={14} />
      </button>
      <span className="sidebar-item-meta">{relativeTime(session.modified)}</span>
    </div>
  )
}

function ProjectRow({
  cwd,
  name,
  liveByPath,
  autoExpanded
}: {
  cwd: string
  name: string
  liveByPath: Map<string, LiveStatus>
  /** True while the project holds the active chat — stays open regardless. */
  autoExpanded?: boolean
}) {
  const sessions = useAppStore((s) => s.sessions)
  const expanded =
    useAppStore((s) => s.appSettings.expandedProjects.includes(cwd)) || autoExpanded === true
  const toggleExpanded = useAppStore((s) => s.toggleProjectExpanded)
  const [showAll, setShowAll] = useState(false)

  const projectSessions = useMemo(
    () => sessions.filter((s) => s.cwd === cwd),
    [sessions, cwd]
  )
  const visible = showAll ? projectSessions : projectSessions.slice(0, MAX_NESTED_CHATS)

  async function contextMenu(): Promise<void> {
    const action = await window.piDesktop.projects.showMenu({ cwd }).catch(() => null)
    switch (action) {
      case 'reveal':
        void window.piDesktop.app.revealPath(cwd)
        break
      case 'new-chat':
        newChatInProject(cwd)
        break
      case 'hide': {
        const current = useAppStore.getState().appSettings.hiddenProjects
        void useAppStore
          .getState()
          .updateAppSettings({ hiddenProjects: [...current, cwd] })
        break
      }
    }
  }

  return (
    <div className="sidebar-project">
      <div
        className="sidebar-item sidebar-project-row"
        role="button"
        tabIndex={0}
        title={cwd}
        onClick={() => toggleExpanded(cwd)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            toggleExpanded(cwd)
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          void contextMenu()
        }}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Folder size={15} />
        <span className="sidebar-item-label">{name}</span>
        <button
          type="button"
          className="icon-btn sidebar-item-more"
          title="New chat in this project"
          onClick={(e) => {
            e.stopPropagation()
            newChatInProject(cwd)
          }}
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          className="icon-btn sidebar-item-more"
          title="Project actions"
          onClick={(e) => {
            e.stopPropagation()
            void contextMenu()
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      {expanded && (
        <div className="sidebar-project-chats">
          {visible.map((session) => (
            <SessionRow
              key={session.path}
              session={session}
              nested
              live={liveByPath.get(session.path)}
            />
          ))}
          {projectSessions.length === 0 && (
            <div className="sidebar-empty sidebar-empty-nested">No chats</div>
          )}
          {projectSessions.length > MAX_NESTED_CHATS && !showAll && (
            <button
              type="button"
              className="sidebar-item sidebar-item-muted sidebar-session-nested"
              onClick={() => setShowAll(true)}
            >
              <span className="sidebar-item-label">
                Show {projectSessions.length - MAX_NESTED_CHATS} more…
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function Sidebar() {
  const sessions = useAppStore((s) => s.sessions)
  const projects = useAppStore((s) => s.projects)
  const workspaceDir = useAppStore((s) => s.appInfo?.workspaceDir ?? '')
  const chatFilter = useAppStore((s) => s.chatFilter)
  const setChatFilter = useAppStore((s) => s.setChatFilter)
  const sidebarSearchOpen = useAppStore((s) => s.sidebarSearchOpen)
  const setSidebarSearchOpen = useAppStore((s) => s.setSidebarSearchOpen)
  const navigate = useAppStore((s) => s.navigate)
  const runtimeInfo = useAppStore((s) => s.runtimeInfo)
  const userName = useAppStore((s) => s.userName)
  const sessionsLoaded = useAppStore((s) => s.sessionsLoaded)
  const chats = useChatStore((s) => s.chats)
  const view = useAppStore((s) => s.view)
  // Auto-expand the project holding the active chat even if the user
  // collapsed it — the row they're looking at should stay visible.
  const activeChatCwd = view.kind === 'chat' ? chats[view.chatId]?.cwd : undefined

  // sessionPath → live status of the open chat running that session, so the
  // sidebar can show a pulsing dot while it streams and an unread dot once a
  // background run settles.
  const liveByPath = useMemo(() => {
    const map = new Map<string, LiveStatus>()
    for (const chat of Object.values(chats)) {
      if (!chat.sessionPath) {
        continue
      }
      const entry = map.get(chat.sessionPath) ?? { streaming: false, unread: false }
      entry.streaming ||= chat.status === 'streaming'
      entry.unread ||= chat.unread === true
      map.set(chat.sessionPath, entry)
    }
    return map
  }, [chats])

  const [projectsCollapsed, setProjectsCollapsed] = useState(false)

  const filtering = chatFilter.trim().length > 0
  const filteredSessions = useMemo(() => {
    const needle = chatFilter.trim().toLowerCase()
    if (!needle) {
      return []
    }
    return sessions.filter((s) => s.title.toLowerCase().includes(needle))
  }, [sessions, chatFilter])

  const projectLessSessions = useMemo(
    () => sessions.filter((s) => isProjectless(s.cwd, workspaceDir)),
    [sessions, workspaceDir]
  )
  const grouped = useMemo(() => groupByDate(projectLessSessions), [projectLessSessions])
  const filteredGrouped = useMemo(() => groupByDate(filteredSessions), [filteredSessions])

  function newChat(): void {
    navigate({ kind: 'home' })
  }

  function toggleSearch(): void {
    if (sidebarSearchOpen) {
      setChatFilter('')
      setSidebarSearchOpen(false)
    } else {
      setSidebarSearchOpen(true)
    }
  }

  async function addProject(): Promise<void> {
    const folder = await window.piDesktop.app.pickFolder().catch(() => null)
    if (folder) {
      await useAppStore.getState().addProject(folder)
    }
  }

  const chatGroups = filtering ? filteredGrouped : grouped

  return (
    <aside className="sidebar">
      <div className="sidebar-topbar drag-region">
        <NavButtons />
      </div>

      <div className="sidebar-scroll">
        <button type="button" className="sidebar-item new-chat" onClick={newChat}>
          <Plus size={15} />
          <span>New chat</span>
          <kbd className="kbd">⌘N</kbd>
        </button>
        <button type="button" className="sidebar-item" onClick={toggleSearch}>
          <Search size={15} />
          <span>Search</span>
          <kbd className="kbd">⌘K</kbd>
        </button>

        {sidebarSearchOpen && (
          <div className="sidebar-search">
            <Search size={13} />
            <input
              autoFocus
              value={chatFilter}
              onChange={(e) => setChatFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  toggleSearch()
                }
              }}
              placeholder="Filter chats"
              spellCheck={false}
            />
            <button
              type="button"
              className="icon-btn"
              title="Close search"
              onClick={toggleSearch}
            >
              <X size={12} />
            </button>
          </div>
        )}

        {!filtering && (
          <>
            <div className="sidebar-section">
              <button
                type="button"
                className="sidebar-section-header"
                onClick={() => setProjectsCollapsed(!projectsCollapsed)}
              >
                {projectsCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span>Projects</span>
              </button>
              <button
                type="button"
                className="icon-btn sidebar-section-add"
                onClick={() => void addProject()}
                title="Add project"
              >
                <Plus size={13} />
              </button>
            </div>
            {!projectsCollapsed &&
              projects.map((project) => (
                <ProjectRow
                  key={project.cwd}
                  cwd={project.cwd}
                  name={project.name}
                  liveByPath={liveByPath}
                  autoExpanded={activeChatCwd === project.cwd}
                />
              ))}
            {!projectsCollapsed && projects.length === 0 && (
              <div className="sidebar-empty">No projects yet</div>
            )}

            <div className="sidebar-section" style={{ marginTop: 8 }}>
              <div className="sidebar-section-header" style={{ cursor: 'default' }}>
                <span>Chats</span>
              </div>
            </div>
          </>
        )}

        {!sessionsLoaded &&
          [0, 1, 2].map((i) => <div key={i} className="sidebar-skeleton" />)}
        {sessionsLoaded &&
          chatGroups.map(({ group, items }) => (
            <div key={group}>
              <div className="sidebar-date-group">{group}</div>
              {items.map((session) => (
                <SessionRow
                  key={session.path}
                  session={session}
                  live={liveByPath.get(session.path)}
                />
              ))}
            </div>
          ))}
        {sessionsLoaded && chatGroups.length === 0 && (
          <div className="sidebar-empty">
            {filtering ? 'No matching chats' : 'No chats yet'}
          </div>
        )}
        <div className="sidebar-spacer" />
      </div>

      <div className="sidebar-footer">
        <div className="avatar">{capitalizeName(userName).charAt(0)}</div>
        <span className="sidebar-footer-name">{capitalizeName(userName)}</span>
        {runtimeInfo && (
          <span
            className="runtime-badge"
            title={`pi ${runtimeInfo.version ?? '?'} (${runtimeInfo.kind}: ${runtimeInfo.command})`}
          >
            <span
              className={clsx('runtime-dot', {
                bundled: runtimeInfo.kind === 'bundled',
                offline: false
              })}
            />
            pi {runtimeInfo.version ?? '?'}
          </span>
        )}
        {!runtimeInfo && (
          <span className="runtime-badge" title="pi not found">
            <span className="runtime-dot offline" />
            no pi
          </span>
        )}
        <button
          type="button"
          className="icon-btn"
          title="Settings (⌘,)"
          onClick={() => useAppStore.getState().openSettings()}
        >
          <Settings size={14} />
        </button>
      </div>
    </aside>
  )
}
