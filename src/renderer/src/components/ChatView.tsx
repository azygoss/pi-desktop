import { ArrowDown, GitFork, RotateCcw } from 'lucide-react'
import { Suspense, lazy, memo, useCallback, useEffect, useRef, useState } from 'react'

import type { DisplayBlock, DisplayMessage, ToolRun } from '../../../shared/chat-view'
import type { ImageContent } from '../../../shared/pi-types'
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
    return <ThinkingBlock text={block.thinking} streaming={streaming} />
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
  if (message.kind === 'user') {
    return (
      <div className="msg-user-row fade-in">
        {onFork !== undefined && userIndex !== undefined && (
          <button
            type="button"
            className="icon-btn msg-fork-btn"
            title="Fork chat from this message"
            onClick={() => onFork(userIndex)}
          >
            <GitFork size={13} />
          </button>
        )}
        <div className="msg-user">
          {message.images.map((img: ImageContent, i: number) => (
            <img
              key={i}
              className="msg-image"
              src={`data:${img.mimeType};base64,${img.data}`}
              alt=""
            />
          ))}
          {message.text}
          {message.queued && <span className="msg-queued">queued — waiting for pi</span>}
        </div>
      </div>
    )
  }
  if (message.kind === 'assistant') {
    return (
      <div className="msg-assistant fade-in">
        {message.blocks.map((block, i) => (
          <MemoAssistantBlock
            key={i}
            block={block}
            run={block.type === 'toolCall' ? toolRuns[block.id] : undefined}
            cwd={cwd}
            streaming={message.streaming}
          />
        ))}
        {message.errorMessage && <div className="msg-error">{message.errorMessage}</div>}
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
  const navigate = useAppStore((s) => s.navigate)

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stickRef.current = nearBottom
    setShowJump(!nearBottom)
  }, [])

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
  let userIndex = -1

  // Before the first token lands there is no assistant block to render yet —
  // show a shimmer placeholder so the stream doesn't look stalled.
  const lastMessage = chat.messages.at(-1)
  const awaitingFirstToken =
    chat.status === 'streaming' &&
    (!lastMessage ||
      (lastMessage.kind === 'assistant' && lastMessage.blocks.length === 0) ||
      lastMessage.kind === 'user' ||
      lastMessage.kind === 'notice')

  function restart(): void {
    const newId = crypto.randomUUID()
    void useChatStore.getState().closeChat(chatId)
    void useChatStore
      .getState()
      .ensureChat(newId, { cwd: chat!.cwd, sessionPath: chat!.sessionPath })
      .catch(() => {})
    navigate({ kind: 'chat', chatId: newId })
  }

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
          {chat.messages.map((m) => {
            const idx = m.kind === 'user' ? ++userIndex : undefined
            return (
              <MemoMessageRow
                key={m.key}
                message={m}
                toolRuns={chat.toolRuns}
                cwd={chat.cwd}
                userIndex={idx}
                onFork={
                  chat.sessionPath && chat.status !== 'streaming' ? onForkMessage : undefined
                }
              />
            )
          })}
          {awaitingFirstToken && (
            <div className="msg-pending" aria-live="polite">
              <span className="shimmer-text">Thinking…</span>
            </div>
          )}
          {chat.error && (
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
            <div className="msg-notice msg-notice-error">
              <button type="button" className="ui-btn" onClick={restart}>
                <RotateCcw size={12} /> Restart chat
              </button>
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
