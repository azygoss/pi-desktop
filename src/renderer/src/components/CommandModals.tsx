import { Copy, ExternalLink, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { useShallow } from 'zustand/react/shallow'

import type { ChatSessionStats, ForkMessage } from '../../../shared/api'
import type { PiTreeResult } from '../../../shared/pi-types'
import { flattenSessionTree } from '../lib/session-tree'
import { collapseWhitespace } from '../../../shared/text'
import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { toast } from '../state/toast-store'

export function ModalShell({
  title,
  onClose,
  children
}: {
  title: string
  onClose(): void
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="cmd-modal"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cmd-modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" title="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="cmd-modal-body">{children}</div>
      </div>
    </div>
  )
}

/** /session — name, id, file path and stats for the current chat. */
function SessionModal({ chatId, onClose }: { chatId: string; onClose(): void }) {
  // Only title + sessionPath are rendered here — subscribing to the whole
  // chat would re-render the modal on every streamed delta.
  const chat = useChatStore(
    useShallow((s) => {
      const c = s.chats[chatId]
      return c ? { title: c.title, sessionPath: c.sessionPath } : undefined
    })
  )
  const [stats, setStats] = useState<ChatSessionStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.piDesktop.chat
      .getStats({ chatId })
      .then((s) => setStats(s ?? null))
      .catch((e) => setError(String(e)))
  }, [chatId])

  const sessionFile = stats?.sessionFile ?? chat?.sessionPath

  return (
    <ModalShell title="Session" onClose={onClose}>
      <dl className="session-info">
        <dt>Name</dt>
        <dd>{chat?.title ?? '—'}</dd>
        <dt>Session id</dt>
        <dd className="mono">{stats?.sessionId ?? '—'}</dd>
        <dt>File</dt>
        <dd className="mono session-path">
          {sessionFile ?? 'Not created yet — send a message first'}
        </dd>
        {sessionFile && (
          <dd className="session-actions">
            <button
              type="button"
              className="ui-btn"
              onClick={() => {
                void navigator.clipboard.writeText(sessionFile)
                toast('Path copied')
              }}
            >
              <Copy size={12} /> Copy path
            </button>
            <button
              type="button"
              className="ui-btn"
              onClick={() => void window.piDesktop.app.revealPath(sessionFile)}
            >
              <ExternalLink size={12} /> Reveal
            </button>
          </dd>
        )}
        <dt>Messages</dt>
        <dd>
          {stats
            ? `${stats.totalMessages ?? 0} total · ${stats.userMessages ?? 0} user · ${
                stats.assistantMessages ?? 0
              } assistant · ${stats.toolCalls ?? 0} tool calls`
            : '—'}
        </dd>
        <dt>Tokens</dt>
        <dd>
          {stats?.tokens
            ? `${stats.tokens.total.toLocaleString()} (in ${stats.tokens.input.toLocaleString()} / out ${stats.tokens.output.toLocaleString()})`
            : '—'}
        </dd>
        <dt>Cost</dt>
        <dd>{stats?.cost !== undefined ? `$${stats.cost.toFixed(4)}` : '—'}</dd>
        <dt>Context</dt>
        <dd>
          {stats?.contextUsage?.percent != null
            ? `${Math.round(stats.contextUsage.percent)}% of ${
                stats.contextUsage.contextWindow?.toLocaleString() ?? '?'
              } tokens`
            : '—'}
        </dd>
      </dl>
      {error && <div className="cmd-modal-error">{error}</div>}
    </ModalShell>
  )
}

/** /fork — pick an earlier user message and fork from it. */
function ForkModal({ chatId, onClose }: { chatId: string; onClose(): void }) {
  const [messages, setMessages] = useState<ForkMessage[] | null>(null)

  useEffect(() => {
    window.piDesktop.chat
      .getForkMessages({ chatId })
      .then((r) => setMessages(r.messages))
      .catch(() => setMessages([]))
  }, [chatId])

  async function pick(entryId: string): Promise<void> {
    onClose()
    await useChatStore.getState().forkAtEntry(chatId, entryId).catch(() => {
      toast('Fork failed')
    })
  }

  return (
    <ModalShell title="Fork from a message" onClose={onClose}>
      {messages === null && <div className="cmd-modal-hint">Loading…</div>}
      {messages !== null && messages.length === 0 && (
        <div className="cmd-modal-hint">No messages to fork from yet.</div>
      )}
      {(messages ?? []).map((m) => (
        <button
          key={m.entryId}
          type="button"
          className="cmd-modal-row"
          onClick={() => void pick(m.entryId)}
        >
          {collapseWhitespace(m.text).slice(0, 120)}
        </button>
      ))}
    </ModalShell>
  )
}

/** /tree — read-only session tree; user entries offer "Fork from here". */
function TreeModal({ chatId, onClose }: { chatId: string; onClose(): void }) {
  const [result, setResult] = useState<PiTreeResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.piDesktop.chat
      .getTree({ chatId })
      .then(setResult)
      .catch((e) => setError(String(e)))
  }, [chatId])

  async function fork(entryId: string): Promise<void> {
    onClose()
    await useChatStore.getState().forkAtEntry(chatId, entryId).catch(() => {
      toast('Fork failed')
    })
  }

  const rows = useMemo(() => (result ? flattenSessionTree(result) : []), [result])

  return (
    <ModalShell title="Session tree" onClose={onClose}>
      {!result && !error && <div className="cmd-modal-hint">Loading…</div>}
      {result && result.tree.length === 0 && (
        <div className="cmd-modal-hint">Empty session.</div>
      )}
      {rows.map((row) => (
        <div
          key={row.id}
          className={clsx('tree-row', { 'is-active': row.active, 'is-leaf': row.leaf, 'is-branch': row.branchStart })}
          style={{ paddingLeft: row.depth * 16 }}
        >
          <span className={row.role === 'user' ? 'tree-role tree-role-user' : 'tree-role'}>{row.role}</span>
          <span className="tree-snippet">{row.snippet}</span>
          {row.leaf && <span className="tree-here">you are here</span>}
          {row.forkable && (
            <button type="button" className="ui-btn tree-fork" onClick={() => void fork(row.id)}>
              Fork from here
            </button>
          )}
        </div>
      ))}
      {error && <div className="cmd-modal-error">{error}</div>}
    </ModalShell>
  )
}

const HOTKEYS: { keys: string; action: string }[] = [
  { keys: '⌘N', action: 'New chat' },
  { keys: '⌘K', action: 'Search chats, conversations and actions' },
  { keys: '⌘F', action: 'Find in chat' },
  { keys: '⌘;', action: 'Ask a side question' },
  { keys: '⌃Tab / ⌃⇧Tab', action: 'Next / previous open chat' },
  { keys: '⌥↑ / ⌥↓', action: 'Previous / next prompt' },
  { keys: '⌘↑ / ⌘↓', action: 'Top / bottom of the chat' },
  { keys: '⌘B', action: 'Toggle sidebar' },
  { keys: '⌘[ / ⌘]', action: 'Back / forward' },
  { keys: '⌘,', action: 'Settings' },
  { keys: '⌃`', action: 'Terminal panel' },
  { keys: 'Enter', action: 'Send message' },
  { keys: 'Enter (streaming)', action: 'Steer the running turn' },
  { keys: '⌥Enter (streaming)', action: 'Queue a follow-up' },
  { keys: '⇧Enter', action: 'Newline in the composer' },
  { keys: '↑ / ↓ (empty composer)', action: 'Earlier / later prompts' },
  { keys: '/', action: 'Slash commands (first character)' },
  { keys: '@', action: 'Mention a project file' },
  { keys: '!', action: 'Run a shell command (first character)' },
  { keys: '⌘U', action: 'Attach files' },
  { keys: '⌘⌥B', action: 'Toggle the side panel' }
]

function HotkeysModal({ onClose }: { onClose(): void }) {
  return (
    <ModalShell title="Keyboard shortcuts" onClose={onClose}>
      <div className="hotkeys-list">
        {HOTKEYS.map((h) => (
          <div key={h.keys} className="hotkeys-row">
            <kbd className="kbd">{h.keys}</kbd>
            <span>{h.action}</span>
          </div>
        ))}
      </div>
    </ModalShell>
  )
}

/** Renders the chat-modal selected via slash commands (/session, /tree, …). */
export function CommandModals() {
  const modal = useAppStore((s) => s.chatModal)
  const view = useAppStore((s) => s.view)
  const chatId = view.kind === 'chat' ? view.chatId : null
  const close = () => useAppStore.getState().setChatModal(null)

  if (!modal) {
    return null
  }
  if (modal === 'hotkeys') {
    return <HotkeysModal onClose={close} />
  }
  if (!chatId) {
    return null
  }
  if (modal === 'session') {
    return <SessionModal chatId={chatId} onClose={close} />
  }
  if (modal === 'fork') {
    return <ForkModal chatId={chatId} onClose={close} />
  }
  if (modal === 'tree') {
    return <TreeModal chatId={chatId} onClose={close} />
  }
  return null
}
