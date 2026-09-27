import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Plus,
  Search,
  Settings
} from 'lucide-react'
import { useMemo, useState } from 'react'
import clsx from 'clsx'

import type { SessionSummary } from '../../../shared/session-types'
import { PiLogo } from './PiLogo'
import { groupByDate } from '../lib/date-groups'
import { capitalizeName } from '../lib/greeting'
import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'

const MAX_PROJECTS = 6

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

export function Sidebar() {
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const sessions = useAppStore((s) => s.sessions)
  const projects = useAppStore((s) => s.projects)
  const activeProjectCwd = useAppStore((s) => s.activeProjectCwd)
  const setActiveProjectCwd = useAppStore((s) => s.setActiveProjectCwd)
  const chatFilter = useAppStore((s) => s.chatFilter)
  const setChatFilter = useAppStore((s) => s.setChatFilter)
  const showAllProjects = useAppStore((s) => s.showAllProjects)
  const setShowAllProjects = useAppStore((s) => s.setShowAllProjects)
  const navigate = useAppStore((s) => s.navigate)
  const view = useAppStore((s) => s.view)
  const runtimeInfo = useAppStore((s) => s.runtimeInfo)
  const userName = useAppStore((s) => s.userName)
  const chats = useChatStore((s) => s.chats)

  const [projectsCollapsed, setProjectsCollapsed] = useState(false)

  const filteredSessions = useMemo(() => {
    let list = sessions
    if (activeProjectCwd) {
      list = list.filter((s) => s.cwd === activeProjectCwd)
    }
    const needle = chatFilter.trim().toLowerCase()
    if (needle) {
      list = list.filter((s) => s.title.toLowerCase().includes(needle))
    }
    return list
  }, [sessions, activeProjectCwd, chatFilter])

  const grouped = useMemo(() => groupByDate(filteredSessions), [filteredSessions])
  const visibleProjects = showAllProjects ? projects : projects.slice(0, MAX_PROJECTS)

  function openSession(session: SessionSummary): void {
    const existing = useChatStore.getState().openSessionChat(session.path)
    const chatId = existing ?? crypto.randomUUID()
    if (!existing) {
      void useChatStore
        .getState()
        .ensureChat(chatId, { sessionPath: session.path })
        .catch(() => {})
    }
    navigate({ kind: 'chat', chatId })
  }

  function newChat(): void {
    navigate({ kind: 'home' })
  }

  function activeChatId(): string | null {
    return view.kind === 'chat' ? view.chatId : null
  }

  function sessionActive(session: SessionSummary): boolean {
    const chatId = activeChatId()
    if (!chatId) {
      return false
    }
    return chats[chatId]?.sessionPath === session.path
  }

  const addProject = async (): Promise<void> => {
    const folder = await window.piDesktop.app.pickFolder()
    if (folder) {
      setActiveProjectCwd(folder)
      void useAppStore.getState().refreshSessions()
    }
  }

  if (collapsed) {
    return (
      <aside className="sidebar sidebar-collapsed">
        <button type="button" className="icon-btn" onClick={newChat} title="New chat (⌘N)">
          <Plus size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => useAppStore.getState().toggleSidebar()}
          title="Expand sidebar (⌘B)"
        >
          <Search size={15} />
        </button>
        <div style={{ flex: 1 }} />
        <button type="button" className="icon-btn" title="Settings">
          <Settings size={15} />
        </button>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <PiLogo size={18} />
        <span className="sidebar-brand">Pi Desktop</span>
        <button
          type="button"
          className="icon-btn"
          onClick={() => useAppStore.getState().toggleSidebar()}
          title="Collapse sidebar (⌘B)"
        >
          <ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} />
        </button>
      </div>

      <div className="sidebar-scroll">
        <button type="button" className="sidebar-item new-chat" onClick={newChat}>
          <Plus size={15} />
          <span>New chat</span>
          <kbd className="kbd">⌘N</kbd>
        </button>

        <div className="sidebar-search">
          <Search size={13} />
          <input
            value={chatFilter}
            onChange={(e) => setChatFilter(e.target.value)}
            placeholder="Search chats"
            spellCheck={false}
          />
        </div>

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
            title="Open folder"
          >
            <Plus size={13} />
          </button>
        </div>

        {!projectsCollapsed &&
          visibleProjects.map((project) => (
            <button
              key={project.cwd || 'other'}
              type="button"
              className={clsx('sidebar-item', {
                'is-active': activeProjectCwd === project.cwd
              })}
              title={project.cwd || project.name}
              onClick={() => setActiveProjectCwd(project.cwd)}
            >
              {activeProjectCwd === project.cwd ? (
                <FolderOpen size={15} />
              ) : (
                <Folder size={15} />
              )}
              <span className="sidebar-item-label">{project.name}</span>
              <span className="sidebar-item-meta">{project.sessionCount}</span>
              <ChevronRight size={12} className="sidebar-item-chevron" />
            </button>
          ))}
        {!projectsCollapsed && projects.length > MAX_PROJECTS && !showAllProjects && (
          <button
            type="button"
            className="sidebar-item sidebar-item-muted"
            onClick={() => setShowAllProjects(true)}
          >
            <span className="sidebar-item-label">Show more…</span>
          </button>
        )}

        <div className="sidebar-section" style={{ marginTop: 8 }}>
          <div className="sidebar-section-header" style={{ cursor: 'default' }}>
            <span>Chats</span>
          </div>
        </div>

        {grouped.map(({ group, items }) => (
          <div key={group}>
            <div className="sidebar-date-group">{group}</div>
            {items.map((session) => (
              <button
                key={session.path}
                type="button"
                className={clsx('sidebar-item', 'sidebar-session', {
                  'is-active': sessionActive(session)
                })}
                onClick={() => openSession(session)}
              >
                {sessionActive(session) && <span className="active-dot" />}
                <span className="sidebar-item-label">{session.title}</span>
                <span className="sidebar-item-meta">{relativeTime(session.modified)}</span>
              </button>
            ))}
          </div>
        ))}
        {filteredSessions.length === 0 && (
          <div className="sidebar-empty">No chats yet</div>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="avatar">{capitalizeName(userName).charAt(0)}</div>
        <span className="sidebar-footer-name">{capitalizeName(userName)}</span>
        {runtimeInfo && (
          <span className="runtime-badge" title={runtimeInfo.command}>
            <span className="runtime-dot" />
            pi {runtimeInfo.version ?? '?'}
            {runtimeInfo.kind === 'bundled' ? ' bundled' : ''}
          </span>
        )}
        {!runtimeInfo && (
          <span className="runtime-badge" title="pi not found">
            <span className="runtime-dot offline" />
            no pi
          </span>
        )}
        <button type="button" className="icon-btn" title="Settings">
          <Settings size={14} />
        </button>
      </div>
    </aside>
  )
}
