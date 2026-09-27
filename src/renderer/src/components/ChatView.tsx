import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Loader2,
  Pencil,
  RotateCcw,
  X,
  Zap
} from 'lucide-react'
import { Suspense, lazy, memo, useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'

import type { DisplayBlock, DisplayMessage, ToolRun } from '../../../shared/chat-view'
import type { ImageContent } from '../../../shared/pi-types'
import { parseSkillPrefix } from '../../../shared/skill-prefix'
import { Perf } from '../lib/perf'
import { summarizeToolNames } from '../lib/tool-summary'
import { useAppStore } from '../state/app-store'
import { useChatStore, type ChatState } from '../state/chat-store'
import { Composer } from './Composer'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCard } from './ToolCard'

// react-markdown + micromark are ~600KB — split out of the main chunk; the
// fallback renders the raw text pre-wrap so content is readable instantly.
const LazyMarkdown = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })))

function MarkdownBlock({ text }: { text: string }) {
  return (
    <Suspense fallback={<div className="markdown markdown-fallback">{text}</div>}>
      <LazyMarkdown text={text} />
    </Suspense>
  )
}

function AssistantBlock({
  block,
  run,
  cwd,
  streaming
}: {
  block: DisplayBlock
  run?: ToolRun
  cwd: string
  streaming?: boolean
}) {
  if (block.type === 'text') {
    return <MarkdownBlock text={block.text} />
  }
  if (block.type === 'thinking') {
    return (
      <ThinkingBlock
        text={block.thinking}
        streaming={streaming}
        durationMs={block.durationMs}
      />
    )
  }
  if (block.type === 'toolCall') {
    const toolRun: ToolRun =
      run ?? {
        toolCallId: block.id,
        name: block.name,
        args: block.arguments,
        status: 'done'
      }
    return <ToolCard run={toolRun} cwd={cwd} />
  }
  if (block.type === 'image') {
    return (
      <img className="msg-image" src={`data:${block.mimeType};base64,${block.data}`} alt="" />
    )
  }
  return null
}

/** Elapsed-seconds label for the "Starting pi…" notice (ticks each second). */
function StartingPiNotice({ startedAt }: { startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0
  return <span>{seconds > 0 ? `Starting pi… ${seconds}s` : 'Starting pi…'}</span>
}

/**
 * Memoized per finalized block: during a stream only the block receiving
 * deltas gets a new object identity, so earlier blocks skip re-parsing.
 */
const MemoAssistantBlock = memo(AssistantBlock)

type ToolCallBlock = Extract<DisplayBlock, { type: 'toolCall' }>
type RenderItem = DisplayBlock | { type: 'toolGroup'; blocks: ToolCallBlock[] }

/**
 * Fold runs of consecutive tool calls into a single group row; a lone call
 * stays a plain card.
 */
function groupToolCalls(blocks: DisplayBlock[]): RenderItem[] {
  const items: RenderItem[] = []
  for (const block of blocks) {
    const last = items[items.length - 1]
    if (block.type !== 'toolCall') {
      items.push(block)
    } else if (last?.type === 'toolGroup') {
      items[items.length - 1] = { type: 'toolGroup', blocks: [...last.blocks, block] }
    } else if (last?.type === 'toolCall') {
      // Second consecutive call: promote the pair into a group.
      items[items.length - 1] = { type: 'toolGroup', blocks: [last, block] }
    } else {
      items.push(block)
    }
  }
  return items
}

/** Plain markdown text of an assistant message (text blocks only). */
function assistantText(message: DisplayMessage): string {
  if (message.kind !== 'assistant') {
    return ''
  }
  return message.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n\n')
    .trim()
}

/** Hover action: copy to clipboard, flip to a check for 1.2s. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current)
    }
  }, [])
  return (
    <button
      type="button"
      className="icon-btn msg-action"
      title={copied ? 'Copied' : 'Copy'}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        if (timer.current) {
          clearTimeout(timer.current)
        }
        timer.current = setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

/**
 * Collapsed summary for a run of consecutive tool calls: "Ran N tools ·
 * read 2 files, …", live-updating while any of them streams. Expands to the
 * individual cards.
 */
function ToolGroup({
  calls,
  toolRuns,
  cwd
}: {
  calls: ToolCallBlock[]
  toolRuns: Record<string, ToolRun>
  cwd: string
}) {
  const [open, setOpen] = useState(false)
  const runs = calls.map(
    (b) =>
      toolRuns[b.id] ?? {
        toolCallId: b.id,
        name: b.name,
        args: b.arguments,
        status: 'done' as const
      }
  )
  const running = runs.some((r) => r.status === 'running')
  const errors = runs.filter((r) => r.status === 'error').length
  const summary = summarizeToolNames(runs.map((r) => r.name))
  return (
    <div className={clsx('tool-card', 'tool-group', { 'tool-error': errors > 0 && !running })}>
      <button type="button" className="tool-row" onClick={() => setOpen(!open)}>
        <span className="tool-chevron">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="tool-name">
          {running
            ? `Running ${runs.length} tools…`
            : `Ran ${runs.length} tool${runs.length === 1 ? '' : 's'}`}
        </span>
        {summary && <span className="tool-summary">{summary}</span>}
        {errors > 0 && <span className="tool-group-errors">{errors} failed</span>}
        <span className="tool-status">
          {running && <Loader2 size={13} className="spin" />}
          {!running && errors === 0 && <Check size={13} />}
          {!running && errors > 0 && <X size={13} />}
        </span>
      </button>
      {open && (
        <div className="tool-group-body">
          {calls.map((call) => (
            <ToolCard
              key={call.id}
              run={
                toolRuns[call.id] ?? {
                  toolCallId: call.id,
                  name: call.name,
                  args: call.arguments,
                  status: 'done'
                }
              }
              cwd={cwd}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function MessageRow({
  message,
  toolRuns,
  cwd,
  userIndex,
  onFork
}: {
  message: DisplayMessage
  toolRuns: Record<string, ToolRun>
  cwd: string
  /** Position among user messages; defined for user rows only. */
  userIndex?: number
  onFork?: (userIndex: number) => void
}) {
  const homeDir = useAppStore((s) => s.appInfo?.homeDir ?? '')
  if (message.kind === 'user') {
    // `/skill:name` messages arrive as <skill> XML + typed text — show chips
    // for the invocations and hide the injected instructions by default.
    const { skills, rest } = parseSkillPrefix(message.text)
    const tilde = (p: string) =>
      homeDir && homeDir !== '/' && p.startsWith(homeDir) ? `~${p.slice(homeDir.length)}` : p
    return (
      <div className="msg-user-row fade-in">
        <div className="msg-user">
          {skills.length > 0 && (
            <div className="skill-chips">
              {skills.map((skill, i) => (
                <span key={i} className="skill-chip" title={tilde(skill.location)}>
                  <Zap size={11} />
                  {skill.name}
                </span>
              ))}
            </div>
          )}
          {message.images.map((img: ImageContent, i: number) => (
            <img
              key={i}
              className="msg-image"
              src={`data:${img.mimeType};base64,${img.data}`}
              alt=""
            />
          ))}
          {rest && <span className="msg-user-text">{rest}</span>}
          {skills.some((s) => s.body) && (
            <details className="skill-details">
              <summary>Show skill instructions</summary>
              {skills
                .filter((s) => s.body)
                .map((s, i) => (
                  <pre key={i} className="skill-body">
                    {s.body}
                  </pre>
                ))}
            </details>
          )}
          {message.queued && <span className="msg-queued">queued — waiting for pi</span>}
        </div>
        <div className="msg-actions">
          <CopyButton text={rest || message.text} />
          {onFork !== undefined && userIndex !== undefined && (
            <button
              type="button"
              className="icon-btn msg-action"
              title="Edit & resend"
              onClick={() => onFork(userIndex)}
            >
              <Pencil size={12} />
            </button>
          )}
        </div>
      </div>
    )
  }
  if (message.kind === 'assistant') {
    const items = groupToolCalls(message.blocks)
    return (
      <div className="msg-assistant fade-in">
        {items.map((item, i) =>
          item.type === 'toolGroup' ? (
            <ToolGroup
              key={`tg-${item.blocks[0]!.id}`}
              calls={item.blocks}
              toolRuns={toolRuns}
              cwd={cwd}
            />
          ) : (
            <MemoAssistantBlock
              key={i}
              block={item}
              run={item.type === 'toolCall' ? toolRuns[item.id] : undefined}
              cwd={cwd}
              streaming={message.streaming}
            />
          )
        )}
        {message.errorMessage && <div className="msg-error">{message.errorMessage}</div>}
        {!message.streaming && assistantText(message) && (
          <div className="msg-actions">
            <CopyButton text={assistantText(message)} />
          </div>
        )}
      </div>
    )
  }
  if (message.kind === 'bash') {
    const run: ToolRun = {
      toolCallId: message.key,
      name: 'bash',
      args: { command: message.command },
      status: message.cancelled || (message.exitCode ?? 0) !== 0 ? 'error' : 'done',
      result: { content: [{ type: 'text', text: message.output }] }
    }
    return <ToolCard run={run} cwd={cwd} className="fade-in" />
  }
  return (
    <div className={`msg-notice msg-notice-${message.tone} fade-in`}>
      <span>{message.text}</span>
    </div>
  )
}

/**
 * Rows re-render only when their own message object or a tool run they
 * display changes — during streaming, deltas replace just the streaming
 * message so every other row keeps its reference and skips render.
 */
const MemoMessageRow = memo(
  MessageRow,
  (prev, next) => {
    if (
      prev.message !== next.message ||
      prev.userIndex !== next.userIndex ||
      prev.onFork !== next.onFork ||
      prev.cwd !== next.cwd
    ) {
      return false
    }
    if (prev.toolRuns === next.toolRuns) {
      return true
    }
    const m = prev.message
    if (m.kind === 'assistant') {
      for (const block of m.blocks) {
        if (block.type === 'toolCall' && prev.toolRuns[block.id] !== next.toolRuns[block.id]) {
          return false
        }
      }
    }
    return true
  }
)

function UiRequestDialog({ chat }: { chat: ChatState }) {
  const request = chat.uiRequest
  const [value, setValue] = useState('')
  const respond = useChatStore.getState().respondUi

  // Display-only methods: acknowledge immediately so the extension never hangs.
  useEffect(() => {
    if (
      request &&
      (request.method === 'setStatus' ||
        request.method === 'setWidget' ||
        request.method === 'setTitle' ||
        request.method === 'set_editor_text' ||
        request.method === 'notify')
    ) {
      respond(chat.chatId, { id: request.id })
    }
  }, [request, chat.chatId, respond])

  if (!request || request.method !== 'select' && request.method !== 'confirm' &&
      request.method !== 'input' && request.method !== 'editor') {
    return null
  }

  if (request.method === 'confirm') {
    return (
      <div className="ui-dialog">
        <div className="ui-dialog-title">{request.title ?? 'Confirm'}</div>
        {request.message && <div className="ui-dialog-body">{request.message}</div>}
        <div className="ui-dialog-actions">
          <button
            type="button"
            className="ui-btn"
            onClick={() =>
              respond(chat.chatId, { id: request.id, confirmed: false, cancelled: true })
            }
          >
            Cancel
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            onClick={() => respond(chat.chatId, { id: request.id, confirmed: true })}
          >
            Confirm
          </button>
        </div>
      </div>
    )
  }
  if (request.method === 'select') {
    return (
      <div className="ui-dialog">
        <div className="ui-dialog-title">{request.title ?? 'Select'}</div>
        <div className="ui-dialog-options">
          {request.options.map((opt) => (
            <button
              key={opt}
              type="button"
              className="ui-btn"
              onClick={() => respond(chat.chatId, { id: request.id, value: opt })}
            >
              {opt}
            </button>
          ))}
          <button
            type="button"
            className="ui-btn"
            onClick={() => respond(chat.chatId, { id: request.id, cancelled: true })}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }
  // input / editor
  const prefill = request.method === 'editor' ? request.prefill : undefined
  return (
    <div className="ui-dialog">
      <div className="ui-dialog-title">{request.title ?? 'Input'}</div>
      {request.method === 'input' ? (
        <input
          className="ui-dialog-input"
          value={value || (prefill ?? '')}
          onChange={(e) => setValue(e.target.value)}
          placeholder={request.placeholder}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              respond(chat.chatId, { id: request.id, value: value || (prefill ?? '') })
            } else if (e.key === 'Escape') {
              respond(chat.chatId, { id: request.id, cancelled: true })
            }
          }}
        />
      ) : (
        <textarea
          className="ui-dialog-input"
          rows={6}
          defaultValue={prefill ?? ''}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              respond(chat.chatId, { id: request.id, cancelled: true })
            }
          }}
        />
      )}
      <div className="ui-dialog-actions">
        <button
          type="button"
          className="ui-btn"
          onClick={() => respond(chat.chatId, { id: request.id, cancelled: true })}
        >
          Cancel
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          onClick={() =>
            respond(chat.chatId, { id: request.id, value: value || (prefill ?? '') })
          }
        >
          OK
        </button>
      </div>
    </div>
  )
}

/** Rows rendered immediately when opening a long transcript; older rows
 * mount in chunks as the user scrolls up so first paint stays fast. */
const INITIAL_RENDER_ROWS = 60
const RENDER_CHUNK_ROWS = 80

function statsFooter(chat: ChatState): string {
  const parts: string[] = []
  const pct = chat.stats?.contextUsage?.percent
  if (typeof pct === 'number') {
    parts.push(`${Math.round(pct)}% context`)
  }
  const tokens = chat.stats?.tokens?.total
  if (typeof tokens === 'number' && tokens > 0) {
    parts.push(
      tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`
    )
  }
  const cost = chat.stats?.cost
  if (typeof cost === 'number' && cost > 0) {
    parts.push(`$${cost.toFixed(cost < 0.01 ? 4 : 2)}`)
  }
  return parts.join(' · ')
}

export function ChatView({ chatId }: { chatId: string }) {
  const chat = useChatStore((s) => s.chats[chatId])
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  // rowsWindow.chatId keeps the count scoped: switching chats starts over at
  // INITIAL_RENDER_ROWS without a reset effect.
  const [rowsWindow, setRowsWindow] = useState({ chatId, rows: INITIAL_RENDER_ROWS })
  const renderRows =
    rowsWindow.chatId === chatId ? rowsWindow.rows : INITIAL_RENDER_ROWS
  const navigate = useAppStore((s) => s.navigate)

  const messageCountForWindow = chat?.messages.length ?? 0
  // Windowed transcript: only the latest rows mount at first. Scrolling near
  // the top expands the window; Chromium's overflow-anchor keeps the viewport
  // steady while rows mount above.
  useEffect(() => {
    if (messageCountForWindow === 0) {
      return
    }
    const el = scrollRef.current
    if (el && el.scrollTop < 480 && renderRows < messageCountForWindow) {
      // Older content already sits against the top edge (short transcript tail).
      setRowsWindow((s) => {
        const base = s.chatId === chatId ? s.rows : INITIAL_RENDER_ROWS
        return { chatId, rows: Math.min(base + RENDER_CHUNK_ROWS, messageCountForWindow) }
      })
    }
  }, [chatId, renderRows, messageCountForWindow])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stickRef.current = nearBottom
    setShowJump(!nearBottom)
    // Scrolling up mounts the next chunk of older rows immediately instead of
    // waiting for an idle callback.
    if (el.scrollTop < 480) {
      setRowsWindow((s) => {
        const base = s.chatId === chatId ? s.rows : INITIAL_RENDER_ROWS
        return base < messageCountForWindow
          ? { chatId, rows: Math.min(base + RENDER_CHUNK_ROWS, messageCountForWindow) }
          : s
      })
    }
  }, [chatId, messageCountForWindow])

  // Bookkeeping for idle eviction in main: this chat is the visible one.
  // Also clears the unread marker a finished background run left behind.
  useEffect(() => {
    void window.piDesktop.chat.focus({ chatId }).catch(() => {})
    useChatStore.getState().markRead(chatId)
  }, [chatId])

  // Stable identity: an inline closure would defeat row memoization.
  const onForkMessage = useCallback(
    (userIdx: number) => {
      void useChatStore
        .getState()
        .forkFromUserMessage(chatId, userIdx)
        .catch(() => {})
    },
    [chatId]
  )

  const messageCount = chat?.messages.length ?? 0
  const streaming = chat?.status === 'streaming'
  // One rAF per publish instead of a sync scroll during render — avoids
  // forcing layout while React is still mutating the list. Short hops
  // animate smoothly; long jumps (initial load) snap.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickRef.current) {
      return
    }
    const raf = requestAnimationFrame(() => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      el.scrollTo({
        top: el.scrollHeight,
        behavior:
          !reduceMotion && !streaming && distance < el.clientHeight * 2
            ? 'smooth'
            : 'auto'
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [chat, messageCount, streaming])

  if (!chat) {
    return (
      <div className="chat-view">
        <div className="chat-empty">
          <p>Chat is not open.</p>
          <button type="button" className="ui-btn" onClick={() => navigate({ kind: 'home' })}>
            Back home
          </button>
        </div>
      </div>
    )
  }

  const footer = statsFooter(chat)
  const hiddenRows = Math.max(0, chat.messages.length - renderRows)
  const visibleMessages =
    hiddenRows > 0 ? chat.messages.slice(hiddenRows) : chat.messages
  // Fork indices count user messages across the whole transcript, so start
  // at however many live in the windowed-off head.
  let userIndex = -1
  if (hiddenRows > 0) {
    for (const m of chat.messages.slice(0, hiddenRows)) {
      if (m.kind === 'user') {
        userIndex += 1
      }
    }
  }

  // Before the first token lands there is no assistant block to render yet —
  // show a shimmer placeholder so the stream doesn't look stalled.
  const lastMessage = chat.messages.at(-1)
  const awaitingFirstToken =
    chat.status === 'streaming' &&
    (!lastMessage ||
      (lastMessage.kind === 'assistant' && lastMessage.blocks.length === 0) ||
      lastMessage.kind === 'user' ||
      lastMessage.kind === 'notice')

  return (
    <div className="chat-view">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-column">
          {chat.hasEarlier && (
            <div className="msg-load-earlier-wrap">
              <button
                type="button"
                className="ui-btn msg-load-earlier"
                onClick={() =>
                  void useChatStore.getState().loadEarlier(chatId).catch(() => {})
                }
              >
                Load earlier messages
              </button>
            </div>
          )}
          {chat.status === 'starting' && (
            <div className="msg-notice msg-notice-info">
              <StartingPiNotice startedAt={chat.startedAt} />
            </div>
          )}
          {hiddenRows > 0 && (
            <div className="msg-window-note" aria-hidden="true">
              …
            </div>
          )}
          {visibleMessages.map((m) => {
            const idx = m.kind === 'user' ? ++userIndex : undefined
            return (
              <Perf key={m.key} id="MessageRow">
                <MemoMessageRow
                  message={m}
                  toolRuns={chat.toolRuns}
                  cwd={chat.cwd}
                  userIndex={idx}
                  onFork={
                    chat.sessionPath && chat.status !== 'streaming' ? onForkMessage : undefined
                  }
                />
              </Perf>
            )
          })}
          {awaitingFirstToken && (
            <div className="msg-pending" aria-live="polite">
              <span className="shimmer-text">Thinking…</span>
            </div>
          )}
          {chat.error && chat.status !== 'exited' && (
            <div className="msg-notice msg-notice-error">
              <span>{chat.error}</span>
              {chat.status === 'error' && (
                <button
                  type="button"
                  className="ui-btn"
                  onClick={() =>
                    void useChatStore
                      .getState()
                      .ensureChat(chatId, { cwd: chat.cwd, sessionPath: chat.sessionPath })
                      .catch(() => {})
                  }
                >
                  <RotateCcw size={12} /> Retry
                </button>
              )}
            </div>
          )}
          {chat.status === 'exited' && (
            <div className="exit-card">
              <div className="exit-card-head">
                <CircleAlert size={15} />
                <div className="exit-card-text">
                  <div className="exit-card-title">
                    {chat.error ?? 'The pi process exited.'}
                  </div>
                  <div className="exit-card-sub">
                    The transcript stays here — restart pi to keep chatting.
                  </div>
                </div>
                <button
                  type="button"
                  className="ui-btn"
                  onClick={() =>
                    void useChatStore
                      .getState()
                      .ensureChat(chatId, { cwd: chat.cwd, sessionPath: chat.sessionPath })
                      .catch(() => {})
                  }
                >
                  <RotateCcw size={12} /> Restart pi
                </button>
              </div>
              {chat.stderrTail && chat.stderrTail.length > 0 && (
                <details className="exit-card-details">
                  <summary>Show details</summary>
                  <pre className="exit-card-stderr">{chat.stderrTail.join('\n')}</pre>
                </details>
              )}
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        className={showJump ? 'jump-pill is-visible' : 'jump-pill'}
        aria-hidden={!showJump}
        tabIndex={showJump ? 0 : -1}
        onClick={() => {
          const el = scrollRef.current
          if (el) {
            const reduceMotion = window.matchMedia(
              '(prefers-reduced-motion: reduce)'
            ).matches
            el.scrollTo({
              top: el.scrollHeight,
              behavior: reduceMotion ? 'auto' : 'smooth'
            })
            stickRef.current = true
          }
        }}
      >
        <ArrowDown size={12} /> Jump to bottom
      </button>

      <UiRequestDialog chat={chat} />

      <div className="chat-composer-dock">
        <Perf id="Composer">
          <Composer
            chat={chat}
            isChat
            onSend={(message, images, mode) => {
              // Sending always re-pins to the bottom — the user's own message
              // and the pending/streaming rows belong in view.
              stickRef.current = true
              void useChatStore.getState().send(chatId, message, images, mode).catch(() => {})
            }}
          />
        </Perf>
        {(footer || streaming) && (
          <div className="chat-stats">
            {footer}
            {footer && streaming ? ' · ' : ''}
            {streaming ? 'Enter to steer · Alt+Enter to queue follow-up' : ''}
          </div>
        )}
      </div>
    </div>
  )
}
