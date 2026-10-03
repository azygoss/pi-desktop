import { ArrowUp, RotateCcw, Square } from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'

import {
  createChatViewState,
  reducePiEvent,
  type ChatViewState,
  type DisplayMessage
} from '../../../shared/chat-view'
import { toolCallSummary } from '../lib/tool-summary'
import { useChatStore } from '../state/chat-store'
import { usePanelStore } from '../state/panel-store'
import { LiveDot } from './LiveIndicators'

const LazyMarkdown = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })))

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method [^:]+: (Error: )?/,
    ''
  )
}

function SideMessage({ message, cwd }: { message: DisplayMessage; cwd: string }) {
  if (message.kind === 'user') {
    return <div className="side-question">{message.text}</div>
  }
  if (message.kind !== 'assistant') {
    return null
  }
  return (
    <div className="side-answer">
      {message.blocks.map((block, i) =>
        block.type === 'text' ? (
          <Suspense key={i} fallback={<div className="markdown markdown-fallback">{block.text}</div>}>
            <LazyMarkdown text={block.text} />
          </Suspense>
        ) : block.type === 'toolCall' ? (
          <div key={i} className="side-tool">
            {block.name} {toolCallSummary(block.name, block.arguments, cwd)}
          </div>
        ) : null
      )}
      {message.errorMessage && <div className="msg-error">{message.errorMessage}</div>}
    </div>
  )
}

/**
 * Side chat: questions answered with the chat's context that leave nothing
 * behind in it. pi runs on a scratch copy of the session as it was when the
 * side chat opened; closing the tab ends it.
 */
export function SidePanel({ chatId, sideId }: { chatId: string; sideId: string }) {
  // Read once at mount: the side chat is a snapshot of the chat at that point.
  const [origin] = useState(() => {
    const chat = useChatStore.getState().chats[chatId]
    return {
      cwd: chat?.cwd ?? '',
      sessionPath: chat?.sessionPath,
      model: chat?.model ? { provider: chat.model.provider, modelId: chat.model.id } : undefined,
      title: chat?.title ?? ''
    }
  })
  // Events are reduced into this mutable state; `shown` is the snapshot the
  // render reads, replaced after each batch.
  const view = useRef<ChatViewState>(createChatViewState())
  const [shown, setShown] = useState<Pick<ChatViewState, 'messages' | 'status'>>({
    messages: [],
    status: 'idle'
  })
  const publish = useCallback(() => {
    setShown({ messages: view.current.messages.slice(), status: view.current.status })
  }, [])
  const [phase, setPhase] = useState<'starting' | 'ready' | 'error'>('starting')
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const opened = useRef<Promise<void> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const seed = usePanelStore((s) => (s.sideSeed?.sideId === sideId ? s.sideSeed : null))

  const start = useCallback((): Promise<void> => {
    setPhase('starting')
    setError(null)
    const promise = window.piDesktop.side
      .open({
        sideId,
        cwd: origin.cwd,
        ...(origin.sessionPath ? { sessionPath: origin.sessionPath } : {}),
        ...(origin.model ? { model: origin.model } : {})
      })
      .then(() => setPhase('ready'))
      .catch((e: unknown) => {
        setPhase('error')
        setError(errorText(e))
        throw e
      })
    opened.current = promise
    promise.catch(() => {})
    return promise
  }, [sideId, origin])

  useEffect(() => {
    const timer = setTimeout(() => void start().catch(() => {}), 0)
    const offEvent = window.piDesktop.side.onEvent((payload) => {
      if (payload.sideId !== sideId) {
        return
      }
      for (const event of payload.events) {
        reducePiEvent(view.current, event)
      }
      publish()
    })
    const offExit = window.piDesktop.side.onExit((payload) => {
      if (payload.sideId === sideId) {
        view.current.status = 'idle'
        publish()
        setPhase('error')
        setError('The side chat ended.')
      }
    })
    return () => {
      clearTimeout(timer)
      offEvent()
      offExit()
      void window.piDesktop.side.close({ sideId }).catch(() => {})
    }
  }, [sideId, start, publish])

  const send = useCallback(
    async (message: string): Promise<void> => {
      const value = message.trim()
      if (!value || view.current.status === 'streaming') {
        return
      }
      view.current.messages.push({
        kind: 'user',
        key: `side-${view.current.messages.length}`,
        text: value,
        images: []
      })
      view.current.status = 'streaming'
      publish()
      try {
        await (opened.current ?? start())
        await window.piDesktop.side.send({ sideId, message: value })
      } catch (e) {
        view.current.status = 'idle'
        setError(errorText(e))
        publish()
      }
    },
    [sideId, start, publish]
  )

  // A question handed over by /btw or ⌘; is asked once.
  const askedSeed = useRef(0)
  useEffect(() => {
    if (seed && seed.nonce !== askedSeed.current) {
      askedSeed.current = seed.nonce
      if (seed.text) {
        const timer = setTimeout(() => void send(seed.text), 0)
        return () => clearTimeout(timer)
      }
      inputRef.current?.focus()
    }
  }, [seed, send])

  // Keep the newest text in view.
  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  })

  const streaming = shown.status === 'streaming'
  const last = shown.messages[shown.messages.length - 1]
  const waiting = streaming && (!last || last.kind === 'user')

  return (
    <div className="side-panel" data-testid="side-panel">
      <div className="diff-toolbar">
        <span className="diff-summary" title={origin.title}>
          {origin.sessionPath ? `Aside from "${origin.title}"` : 'Side chat'}
        </span>
        <button
          type="button"
          className="icon-btn"
          title="Start over with the chat as it is now"
          onClick={() => usePanelStore.getState().restartSide(chatId)}
        >
          <RotateCcw size={13} />
        </button>
      </div>
      <div className="side-body" ref={scrollRef}>
        <div className="cmd-modal-hint side-note">
          {origin.sessionPath
            ? 'pi answers with this chat as context. Nothing said here is added to the chat.'
            : 'This chat has no history yet, so pi answers without its context.'}
        </div>
        {shown.messages.map((message) => (
          <SideMessage key={message.key} message={message} cwd={origin.cwd} />
        ))}
        {waiting && (
          <div className="msg-pending">
            <LiveDot className="composer-status-dot" />
            <span>{phase === 'starting' ? 'Starting pi' : 'Thinking'}</span>
          </div>
        )}
        {error && <div className="msg-error">{error}</div>}
      </div>
      <div className="side-composer">
        <textarea
          ref={inputRef}
          className="side-input"
          rows={2}
          value={text}
          placeholder="Ask a side question"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (!streaming) {
                void send(text)
                setText('')
              }
            }
          }}
        />
        <button
          type="button"
          className="send-btn send-active"
          title={streaming ? 'Stop' : 'Ask'}
          disabled={!streaming && !text.trim()}
          onClick={() => {
            if (streaming) {
              void window.piDesktop.side.abort({ sideId }).catch(() => {})
            } else {
              void send(text)
              setText('')
            }
          }}
        >
          {streaming ? <Square size={12} fill="currentColor" /> : <ArrowUp size={15} />}
        </button>
      </div>
    </div>
  )
}
