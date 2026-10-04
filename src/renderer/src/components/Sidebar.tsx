import {
  Archive,
  ChevronDown,
  ChevronRight,
  Clock,
  GitBranch,
  MoreHorizontal,
  Pin,
  Plus,
  Search,
  Settings,
  Trash2,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import clsx from 'clsx'

import type { SessionSummary } from '../../../shared/session-types'
import { groupByDate } from '../lib/date-groups'
import { capitalizeName } from '../lib/greeting'
import { runSessionMenuAction } from '../lib/session-actions'
import { warmProjectSoon } from '../lib/warm'
import { newChatInWorktree, removeWorktreeProject } from '../lib/worktree-actions'
import { Perf } from '../lib/perf'
import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { ModalShell } from './CommandModals'
import { NavButtons } from './TitleBar'
import { LiveDot } from './LiveIndicators'
import { ProjectSigil } from './Pixels'

const MAX_NESTED_CHATS = 3

/** Chats that run in the app scratch dir (or have no recorded cwd) are
 *  "project-less" and live in the Chats section, not under a project. */
export function isProjectless(cwd: string, workspaceDir: string): boolean {
  return cwd === workspaceDir || cwd === ''
}

/** Muted project label for a session row; null when the chat is project-less. */
function projectSuffix(cwd: string, workspaceDir: string): string | undefined {
  if (!cwd || cwd === workspaceDir) {
    return undefined
  }
  return cwd.split('/').filter(Boolean).pop() ?? undefined
}

export function relativeTime(iso: string): string {
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

/** Open (or reveal) the chat for a session file — shared with the palette. */
export function openSession(session: SessionSummary): void {
  const existing = useChatStore.getState().openSessionChat(session.path)
  if (existing) {
    useAppStore.getState().navigate({ kind: 'chat', chatId: existing })
    return
  }
  void (async () => {
    // A paired phone may already have this session open in main: join that
    // chat instead of starting a second pi on the same session file.
    const live = await window.piDesktop.chat
      .chatIdForSession({ sessionPath: session.path })
      .catch(() => undefined)
    const chatId =
      useChatStore.getState().openSessionChat(session.path) ?? live ?? crypto.randomUUID()
    if (!useChatStore.getState().chats[chatId]) {
      void useChatStore
        .getState()
        .ensureChat(chatId, { sessionPath: session.path })
        .catch(() => {})
    }
    useAppStore.getState().navigate({ kind: 'chat', chatId })
  })()
}

/** Start a draft chat inside a project — shared with the palette. */
export function newChatInProject(cwd: string): void {
  const chatId = crypto.randomUUID()
  void useChatStore
    .getState()
    .ensureChat(chatId, { cwd })
    .catch(() => {})
  useAppStore.getState().navigate({ kind: 'chat', chatId })
}

async function exportSession(session: SessionSummary): Promise<void> {
  const base =
    session.title
      .replace(/[^\w\s-]+/g, '')
      .trim()
      .slice(0, 60) || 'chat'
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

/** Compact per-session code so the selector below stays shallow-equal while
 *  a stream only changes deltas: 'i' = needs input, 's' = streaming,
 *  'e' = errored, 'u' = unread. */
type LiveCode = string

const LIVE_INPUT = (code: LiveCode | undefined) => code?.includes('i') === true
const LIVE_STREAMING = (code: LiveCode | undefined) => code?.includes('s') === true
const LIVE_ERROR = (code: LiveCode | undefined) => code?.includes('e') === true
const LIVE_UNREAD = (code: LiveCode | undefined) => code?.includes('u') === true

/** A pending interactive ui-request (auto-acked display methods don't count). */
function needsInput(uiRequest: { method: string } | undefined): boolean {
  return (
    uiRequest !== undefined &&
    (uiRequest.method === 'confirm' ||
      uiRequest.method === 'select' ||
      uiRequest.method === 'input' ||
      uiRequest.method === 'editor')
  )
}

function SessionRow({
  session,
  nested,
  live,
  suffix,
  pinned
}: {
  session: SessionSummary
  nested?: boolean
  live?: LiveCode
  /** Muted trailing label — the project name in Pinned, "Archived" in search. */
  suffix?: string
  pinned?: boolean
}) {
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const active = isSessionActive(session)
  const archived = useAppStore((s) => s.sessionMeta[session.path]?.archived !== undefined)

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
    await window.piDesktop.sessions.rename({ sessionPath: session.path, name }).catch(() => {})
    useAppStore.getState().renameSession(session.path, name)
    void useAppStore.getState().refreshSessions()
  }

  async function contextMenu(): Promise<void> {
    const action = await window.piDesktop.sessions
      .showMenu({ sessionPath: session.path, pinned, archived })
      .catch(() => null)
    switch (action) {
      case 'pin':
      case 'unpin':
      case 'archive':
      case 'unarchive':
        void runSessionMenuAction(session, action)
        break
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
      data-session-path={session.path}
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
      {pinned && <Pin size={10} className="pin-glyph" aria-hidden="true" />}
      {suffix && <span className="sidebar-item-suffix">{suffix}</span>}
      {LIVE_INPUT(live) && <LiveDot className="input-dot" title="Needs your input" />}
      {!LIVE_INPUT(live) && LIVE_STREAMING(live) && (
        <LiveDot className="live-dot" title="Working…" />
      )}
      {!LIVE_INPUT(live) && !LIVE_STREAMING(live) && LIVE_ERROR(live) && (
        <span className="error-dot" title="Stopped with an error" />
      )}
      {!LIVE_INPUT(live) &&
        !LIVE_STREAMING(live) &&
        !LIVE_ERROR(live) &&
        LIVE_UNREAD(live) && <span className="unread-dot" title="New reply" />}
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
      {/* While a status dot is showing it stands in for the timestamp. */}
      {!live && <span className="sidebar-item-meta">{relativeTime(session.modified)}</span>}
    </div>
  )
}

function ProjectRow({
  cwd,
  name,
  worktree,
  liveByPath,
  autoExpanded
}: {
  cwd: string
  name: string
  /** A git worktree the app created — marked with a branch glyph. */
  worktree?: boolean
  liveByPath: Record<string, LiveCode>
  /** True while the project holds the active chat — stays open regardless. */
  autoExpanded?: boolean
}) {
  const sessions = useAppStore((s) => s.sessions)
  const sessionMeta = useAppStore((s) => s.sessionMeta)
  const expanded =
    useAppStore((s) => s.appSettings.expandedProjects.includes(cwd)) || autoExpanded === true
  const toggleExpanded = useAppStore((s) => s.toggleProjectExpanded)
  const [showAll, setShowAll] = useState(false)

  // Archived chats drop out of every section; pinned keep their place here
  // and additionally appear in the Pinned section (like ChatGPT).
  const projectSessions = useMemo(
    () =>
      sessions.filter((s) => s.cwd === cwd && sessionMeta[s.path]?.archived === undefined),
    [sessions, cwd, sessionMeta]
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
      case 'new-worktree':
        void newChatInWorktree(cwd)
        break
      case 'open-in':
        void window.piDesktop.app.openInMenu({ cwd }).catch(() => {})
        break
      case 'remove-worktree':
        void removeWorktreeProject(cwd, name)
        break
      case 'hide': {
        const current = useAppStore.getState().appSettings.hiddenProjects
        void useAppStore.getState().updateAppSettings({ hiddenProjects: [...current, cwd] })
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
        onMouseEnter={() => warmProjectSoon(cwd)}
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
        <span className="sidebar-chevron" aria-hidden="true">
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <ProjectSigil seed={cwd} />
        <span className="sidebar-item-label">{name}</span>
        {worktree && (
          <span className="worktree-glyph" title="Git worktree">
            <GitBranch size={10} />
          </span>
        )}
        {projectSessions.length > 0 && (
          <span className="sidebar-item-meta sidebar-project-count">
            {projectSessions.length}
          </span>
        )}
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
              live={liveByPath[session.path]}
              pinned={sessionMeta[session.path]?.pinned !== undefined}
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

/** Archived-chat list: searchable, click to open, per-row Unarchive/Delete. */
function ArchivedModal({
  sessions,
  onClose
}: {
  sessions: SessionSummary[]
  onClose(): void
}) {
  const [query, setQuery] = useState('')
  const workspaceDir = useAppStore((s) => s.appInfo?.workspaceDir ?? '')
  const sessionMeta = useAppStore((s) => s.sessionMeta)
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const sorted = [...sessions].sort(
      (a, b) =>
        (sessionMeta[b.path]?.archived ?? 0) - (sessionMeta[a.path]?.archived ?? 0)
    )
    return needle ? sorted.filter((s) => s.title.toLowerCase().includes(needle)) : sorted
  }, [sessions, sessionMeta, query])

  return (
    <ModalShell title="Archived chats" onClose={onClose}>
      <div className="folder-popover-search archived-search">
        <Search size={12} />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search archived chats"
          spellCheck={false}
        />
      </div>
      <div className="archived-list">
        {filtered.map((session) => (
          <div
            key={session.path}
            className="archived-row"
            role="button"
            tabIndex={0}
            onClick={() => {
              onClose()
              openSession(session)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onClose()
                openSession(session)
              }
            }}
          >
            <Archive size={13} className="archived-row-icon" />
            <span className="archived-row-title">{session.title}</span>
            {projectSuffix(session.cwd, workspaceDir) && (
              <span className="archived-row-project">
                {projectSuffix(session.cwd, workspaceDir)}
              </span>
            )}
            <button
              type="button"
              className="ui-btn archived-row-btn"
              onClick={(e) => {
                e.stopPropagation()
                void useAppStore
                  .getState()
                  .setSessionMeta(session.path, { archived: false })
              }}
            >
              Unarchive
            </button>
            <button
              type="button"
              className="icon-btn archived-row-btn"
              title="Move to Trash…"
              onClick={(e) => {
                e.stopPropagation()
                void deleteSession(session)
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {filtered.length === 0 && <div className="cmd-modal-hint">No archived chats.</div>}
      </div>
    </ModalShell>
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
  const updateInfo = useAppStore((s) => s.updateInfo)
  const dismissedUpdate = useAppStore((s) => s.appSettings.updates?.dismissedVersion)
  const sessionsLoaded = useAppStore((s) => s.sessionsLoaded)
  const view = useAppStore((s) => s.view)
  const activeChatCwd = useChatStore((s) =>
    view.kind === 'chat' ? s.chats[view.chatId]?.cwd : undefined
  )

  // sessionPath → 's'/'u' code for open chats. The selector returns plain
  // strings so useShallow keeps the sidebar quiet during stream flushes:
  // deltas replace message objects but not status or unread flags.
  const liveByPath = useChatStore(
    useShallow((s) => {
      const out: Record<string, LiveCode> = {}
      for (const chat of Object.values(s.chats)) {
        if (!chat.sessionPath) {
          continue
        }
        let code = out[chat.sessionPath] ?? ''
        if (needsInput(chat.uiRequest) && !code.includes('i')) {
          code += 'i'
        }
        if (chat.status === 'streaming' && !code.includes('s')) {
          code += 's'
        }
        if ((chat.status === 'error' || chat.error !== undefined) && !code.includes('e')) {
          code += 'e'
        }
        if (chat.unread === true && !code.includes('u')) {
          code += 'u'
        }
        out[chat.sessionPath] = code
      }
      return out
    })
  )

  const [projectsCollapsed, setProjectsCollapsed] = useState(false)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const sessionMeta = useAppStore((s) => s.sessionMeta)

  const filtering = chatFilter.trim().length > 0
  // Search spans everything — archived rows get an "Archived" suffix tag.
  const filteredSessions = useMemo(() => {
    const needle = chatFilter.trim().toLowerCase()
    if (!needle) {
      return []
    }
    return sessions.filter((s) => s.title.toLowerCase().includes(needle))
  }, [sessions, chatFilter])

  const activeSessions = useMemo(
    () => sessions.filter((s) => sessionMeta[s.path]?.archived === undefined),
    [sessions, sessionMeta]
  )
  const pinnedSessions = useMemo(
    () =>
      activeSessions
        .filter((s) => sessionMeta[s.path]?.pinned !== undefined)
        .sort(
          (a, b) =>
            (sessionMeta[b.path]!.pinned ?? 0) - (sessionMeta[a.path]!.pinned ?? 0)
        ),
    [activeSessions, sessionMeta]
  )
  const archivedCount = sessions.length - activeSessions.length

  const projectLessSessions = useMemo(
    () => activeSessions.filter((s) => isProjectless(s.cwd, workspaceDir)),
    [activeSessions, workspaceDir]
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
    <Perf id="Sidebar">
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
            <kbd className="kbd">⌘⇧F</kbd>
          </button>

          <button
            type="button"
            className="sidebar-item"
            data-testid="open-automations"
            onClick={() => useAppStore.getState().setAutomationsOpen(true)}
          >
            <Clock size={15} />
            <span>Automations</span>
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

          {!filtering && pinnedSessions.length > 0 && (
            <div className="sidebar-section">
              <div className="sidebar-section-header" style={{ cursor: 'default' }}>
                <span>Pinned</span>
                <span className="sidebar-section-count">{pinnedSessions.length}</span>
              </div>
            </div>
          )}
          {!filtering &&
            pinnedSessions.map((session) => (
              <SessionRow
                key={session.path}
                session={session}
                live={liveByPath[session.path]}
                suffix={projectSuffix(session.cwd, workspaceDir)}
              />
            ))}

          {!filtering && (
            <>
              <div className="sidebar-section">
                <button
                  type="button"
                  className="sidebar-section-header"
                  onClick={() => setProjectsCollapsed(!projectsCollapsed)}
                >
                  <span>Projects</span>
                  {projectsCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
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
                    worktree={project.worktree}
                    liveByPath={liveByPath}
                    autoExpanded={activeChatCwd === project.cwd}
                  />
                ))}
              {!projectsCollapsed && projects.length === 0 && (
                <div className="sidebar-empty">No projects yet</div>
              )}

              <div className="sidebar-section">
                <div className="sidebar-section-header" style={{ cursor: 'default' }}>
                  <span>Chats</span>
                  {projectLessSessions.length > 0 && (
                    <span className="sidebar-section-count">{projectLessSessions.length}</span>
                  )}
                </div>
              </div>
            </>
          )}

          {!sessionsLoaded && [0, 1, 2].map((i) => <div key={i} className="sidebar-skeleton" />)}
          {sessionsLoaded &&
            chatGroups.map(({ group, items }) => (
              <div key={group}>
                <div className="sidebar-date-group">{group}</div>
                {items.map((session) => (
                  <SessionRow
                    key={session.path}
                    session={session}
                    live={liveByPath[session.path]}
                    pinned={sessionMeta[session.path]?.pinned !== undefined}
                    suffix={
                      filtering && sessionMeta[session.path]?.archived !== undefined
                        ? 'Archived'
                        : undefined
                    }
                  />
                ))}
              </div>
            ))}
          {sessionsLoaded && chatGroups.length === 0 && (
            <div className="sidebar-empty">{filtering ? 'No matching chats' : 'No chats yet'}</div>
          )}
          <div className="sidebar-spacer" />
          {!filtering && archivedCount > 0 && (
            <button
              type="button"
              className="sidebar-item sidebar-item-muted sidebar-archived"
              onClick={() => setArchivedOpen(true)}
            >
              <Archive size={13} />
              <span>Archived</span>
              <span className="sidebar-item-meta">{archivedCount}</span>
            </button>
          )}
        </div>

        <div className="sidebar-footer">
          <div className="avatar" aria-hidden="true">
            {capitalizeName(userName).charAt(0)}
          </div>
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
          {updateInfo && updateInfo.version !== dismissedUpdate && (
            <span className="update-pill" data-testid="update-pill">
              <button
                type="button"
                className="update-pill-btn"
                title={`Open the release notes for ${updateInfo.version}`}
                onClick={() => void window.piDesktop.updates.open()}
              >
                Update {updateInfo.version}
              </button>
              <button
                type="button"
                className="update-pill-dismiss"
                title="Dismiss"
                aria-label={`Dismiss update ${updateInfo.version}`}
                onClick={() =>
                  void useAppStore.getState().updateAppSettings({
                    updates: {
                      ...useAppStore.getState().appSettings.updates,
                      dismissedVersion: updateInfo.version
                    }
                  })
                }
              >
                <X size={10} />
              </button>
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
      {archivedOpen && (
        <ArchivedModal
          sessions={sessions.filter((s) => sessionMeta[s.path]?.archived !== undefined)}
          onClose={() => setArchivedOpen(false)}
        />
      )}
    </Perf>
  )
}
