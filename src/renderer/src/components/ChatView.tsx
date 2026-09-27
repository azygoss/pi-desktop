import { ArrowDown, GitFork, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { DisplayBlock, DisplayMessage, ToolRun } from '../../../shared/chat-view'
import type { ImageContent } from '../../../shared/pi-types'
import { useAppStore } from '../state/app-store'
import { useChatStore, type ChatState } from '../state/chat-store'
import { Composer } from './Composer'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCard } from './ToolCard'

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
    return <Markdown text={block.text} />
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

function MessageRow({
  message,
  chat,
  userIndex,
  onFork
}: {
  message: DisplayMessage
  chat: ChatState
  /** Position among user messages; defined for user rows only. */
  userIndex?: number
  onFork?: (userIndex: number) => void
}) {
  if (message.kind === 'user') {
    return (
      <div className="msg-user-row">
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
        </div>
      </div>
    )
  }
  if (message.kind === 'assistant') {
    return (
      <div className="msg-assistant">
        {message.blocks.map((block, i) => (
          <AssistantBlock
            key={i}
            block={block}
            run={block.type === 'toolCall' ? chat.toolRuns[block.id] : undefined}
            cwd={chat.cwd}
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
    return <ToolCard run={run} cwd={chat.cwd} />
  }
  return (
    <div className={`msg-notice msg-notice-${message.tone}`}>
      <span>{message.text}</span>
    </div>
  )
}

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

  const messageCount = chat?.messages.length ?? 0
  const streaming = chat?.status === 'streaming'
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messageCount, streaming, chat])

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

  function onForkMessage(userIdx: number): void {
    void useChatStore
      .getState()
      .forkFromUserMessage(chatId, userIdx)
      .catch(() => {})
  }

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
          {chat.status === 'starting' && (
            <div className="msg-notice msg-notice-info">
              <span>Starting pi…</span>
            </div>
          )}
          {chat.messages.map((m) => {
            const idx = m.kind === 'user' ? ++userIndex : undefined
            return (
              <MessageRow
                key={m.key}
                message={m}
                chat={chat}
                userIndex={idx}
                onFork={
                  chat.sessionPath && chat.status !== 'streaming' ? onForkMessage : undefined
                }
              />
            )
          })}
          {chat.error && (
            <div className="msg-notice msg-notice-error">
              <span>{chat.error}</span>
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

      {showJump && (
        <button
          type="button"
          className="jump-pill"
          onClick={() => {
            const el = scrollRef.current
            if (el) {
              el.scrollTop = el.scrollHeight
              stickRef.current = true
              setShowJump(false)
            }
          }}
        >
          <ArrowDown size={12} /> Jump to bottom
        </button>
      )}

      <UiRequestDialog chat={chat} />

      <div className="chat-composer-dock">
        <Composer
          chat={chat}
          isChat
          onSend={(message, images, mode) => {
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
