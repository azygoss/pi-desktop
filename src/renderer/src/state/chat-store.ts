import { create } from 'zustand'
import type {
  ChatOpenResult,
  ChatSendMode,
  ChatSessionStats
} from '../../../shared/api'
import {
  buildChatViewState,
  createChatViewState,
  reducePiEvent,
  type ChatViewState,
  type DisplayMessage
} from '../../../shared/chat-view'
import type {
  ExtensionUiRequest,
  ImageContent,
  Model,
  PiCommandInfo,
  PiEvent,
  ThinkingLevel
} from '../../../shared/pi-types'

export interface ChatState extends ChatViewState {
  chatId: string
  sessionPath?: string
  cwd: string
  title: string
  model: Model | null
  thinkingLevel: ThinkingLevel | null
  availableThinkingLevels: ThinkingLevel[]
  models: Model[]
  commands: PiCommandInfo[]
  stats?: ChatSessionStats
  error?: string
  uiRequest?: ExtensionUiRequest
  /** Text handed back by fork for the composer to preload (nonce bumps each time). */
  composerSeed?: { text: string; nonce: number }
}

interface ChatStoreState {
  chats: Record<string, ChatState>
  /** sessionPath → chatId for chats currently open, so session clicks reuse. */
  openSessionChat(sessionPath: string): string | undefined
  ensureChat(chatId: string, input: { cwd?: string; sessionPath?: string }): Promise<void>
  send(chatId: string, message: string, images: ImageContent[] | undefined, mode: ChatSendMode): Promise<void>
  abort(chatId: string): Promise<void>
  setModel(chatId: string, provider: string, modelId: string): Promise<void>
  setThinkingLevel(chatId: string, level: ThinkingLevel): Promise<void>
  setCwd(chatId: string, cwd: string): Promise<void>
  closeChat(chatId: string): Promise<void>
  /** Re-fetch state/messages after fork/clone changes the underlying session. */
  refresh(chatId: string): Promise<void>
  /**
   * Fork the session at the user message at `userIndex` (position among user
   * messages). Returns the message text pi hands back for editing.
   */
  forkFromUserMessage(chatId: string, userIndex: number): Promise<string | undefined>
  /** Clone the current session branch; the chat continues on the new session. */
  cloneChat(chatId: string): Promise<void>
  setChatTitle(chatId: string, title: string): void
  respondUi(chatId: string, response: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }): void
}

// Mutable per-chat drafts; events are applied immediately but React only sees
// state after an animation-frame flush, so token deltas batch into one render.
const drafts = new Map<string, ChatState>()
const pendingEvents = new Map<string, PiEvent[]>()
let flushScheduled = false
let statsTimer: ReturnType<typeof setTimeout> | null = null

function publish(chatId: string): void {
  const draft = drafts.get(chatId)
  if (!draft) {
    return
  }
  useChatStore.setState((s) => ({
    chats: {
      ...s.chats,
      [chatId]: { ...draft, messages: draft.messages.slice(), toolRuns: { ...draft.toolRuns } }
    }
  }))
}

function flushPending(): void {
  flushScheduled = false
  let statsDirty = false
  for (const [chatId, events] of pendingEvents) {
    const draft = drafts.get(chatId)
    if (!draft) {
      continue
    }
    for (const event of events) {
      if (reducePiEvent(draft, event)) {
        statsDirty = true
      }
    }
    publish(chatId)
  }
  pendingEvents.clear()
  if (statsDirty) {
    scheduleStatsRefresh()
  }
}

function enqueueEvent(chatId: string, event: PiEvent): void {
  const queue = pendingEvents.get(chatId)
  if (queue) {
    queue.push(event)
  } else {
    pendingEvents.set(chatId, [event])
  }
  if (!flushScheduled) {
    flushScheduled = true
    requestAnimationFrame(flushPending)
  }
}

function scheduleStatsRefresh(): void {
  if (statsTimer) {
    clearTimeout(statsTimer)
  }
  statsTimer = setTimeout(() => {
    statsTimer = null
    for (const [chatId, draft] of drafts) {
      if (draft.status === 'idle' || draft.status === 'streaming') {
        void window.piDesktop.chat
          .getStats({ chatId })
          .then((stats) => {
            const current = drafts.get(chatId)
            if (current && stats) {
              current.stats = stats
              // pi allocates the session file on first prompt; pick it up so
              // the sidebar can highlight the active session.
              if (stats.sessionFile && !current.sessionPath) {
                current.sessionPath = stats.sessionFile
              }
              publish(chatId)
            }
          })
          .catch(() => {})
      }
    }
  }, 150)
}

let bridgeInitialized = false

export function initChatBridge(): void {
  if (bridgeInitialized) {
    return
  }
  bridgeInitialized = true

  window.piDesktop.chat.onEvent(({ chatId, event }) => {
    enqueueEvent(chatId, event)
  })

  window.piDesktop.chat.onUiRequest(({ chatId, request }) => {
    const draft = drafts.get(chatId)
    if (draft) {
      draft.uiRequest = request
      publish(chatId)
    }
  })

  window.piDesktop.chat.onExit(({ chatId, code, stderrTail }) => {
    const draft = drafts.get(chatId)
    if (!draft) {
      return
    }
    draft.status = 'exited'
    draft.error =
      code === 0
        ? 'The pi process exited.'
        : `The pi process exited with code ${code}.`
    if (stderrTail.length > 0) {
      draft.error += `\n${stderrTail.join('\n')}`
    }
    publish(chatId)
  })
}

let optimisticCounter = 0
let seedCounter = 0

export const useChatStore = create<ChatStoreState>((set, get) => ({
  chats: {},

  openSessionChat(sessionPath) {
    for (const chat of Object.values(get().chats)) {
      if (chat.sessionPath === sessionPath && chat.status !== 'exited') {
        return chat.chatId
      }
    }
    for (const chat of drafts.values()) {
      if (chat.sessionPath === sessionPath) {
        return chat.chatId
      }
    }
    return undefined
  },

  async ensureChat(chatId, input) {
    const existing = drafts.get(chatId)
    if (existing && existing.status !== 'starting') {
      return
    }
    const draft: ChatState = {
      ...createChatViewState(),
      chatId,
      cwd: input.cwd ?? '',
      sessionPath: input.sessionPath,
      title: 'New chat',
      status: 'starting',
      model: null,
      thinkingLevel: null,
      availableThinkingLevels: [],
      models: [],
      commands: []
    }
    drafts.set(chatId, draft)
    publish(chatId)

    const result: ChatOpenResult = await window.piDesktop.chat.open({
      chatId,
      cwd: input.cwd,
      sessionPath: input.sessionPath
    })

    const view = buildChatViewState(result.messages)
    const current = drafts.get(chatId)
    if (!current) {
      return // closed while opening
    }
    current.status = view.messages.length > 0 || result.state.isStreaming ? view.status : 'idle'
    if (result.state.isStreaming) {
      current.status = 'streaming'
    }
    current.messages = view.messages
    current.toolRuns = view.toolRuns
    current.model = result.state.model
    current.thinkingLevel = result.state.thinkingLevel
    current.availableThinkingLevels = result.thinkingLevels
    current.models = result.models
    current.commands = result.commands
    current.cwd = result.cwd || current.cwd
    current.sessionPath = result.sessionPath ?? input.sessionPath
    const firstUser = view.messages.find((m) => m.kind === 'user')
    if (firstUser && firstUser.kind === 'user' && firstUser.text.trim()) {
      current.title = firstUser.text.slice(0, 80)
    }
    publish(chatId)
  },

  async send(chatId, message, images, mode) {
    const draft = drafts.get(chatId)
    if (!draft) {
      throw new Error('Chat is not open')
    }
    const display: DisplayMessage = {
      kind: 'user',
      key: `local-${++optimisticCounter}`,
      text: message,
      images: images ?? [],
      timestamp: Date.now()
    }
    draft.messages.push(display)
    if (draft.title === 'New chat' && message.trim()) {
      draft.title = message.replace(/\s+/g, ' ').trim().slice(0, 80)
    }
    draft.status = 'streaming'
    publish(chatId)
    try {
      await window.piDesktop.chat.send({ chatId, message, images, mode })
    } catch (error) {
      draft.error = error instanceof Error ? error.message : String(error)
      draft.status = 'error'
      publish(chatId)
      throw error
    }
  },

  async abort(chatId) {
    await window.piDesktop.chat.abort({ chatId })
  },

  async setModel(chatId, provider, modelId) {
    const result = await window.piDesktop.chat.setModel({ chatId, provider, modelId })
    const draft = drafts.get(chatId)
    if (draft) {
      // The RPC result is authoritative: pi may clamp the thinking level for
      // the new model and the level list is model-specific.
      draft.model =
        result.model ??
        draft.models.find((m) => m.provider === provider && m.id === modelId) ??
        draft.model
      draft.thinkingLevel = result.thinkingLevel ?? draft.thinkingLevel
      draft.availableThinkingLevels = result.thinkingLevels
      publish(chatId)
    }
  },

  async setThinkingLevel(chatId, level) {
    await window.piDesktop.chat.setThinkingLevel({ chatId, level })
    const draft = drafts.get(chatId)
    if (draft) {
      draft.thinkingLevel = level
      publish(chatId)
    }
  },

  async setCwd(chatId, cwd) {
    const draft = drafts.get(chatId)
    const result = await window.piDesktop.chat.setCwd({ chatId, cwd })
    if (!draft) {
      return
    }
    const view = buildChatViewState(result.messages)
    Object.assign(draft, view, {
      cwd,
      sessionPath: result.sessionPath,
      model: result.state.model,
      thinkingLevel: result.state.thinkingLevel,
      availableThinkingLevels: result.thinkingLevels,
      models: result.models,
      commands: result.commands,
      error: undefined,
      stats: undefined,
      uiRequest: undefined
    })
    draft.status = 'idle'
    publish(chatId)
  },

  async closeChat(chatId) {
    drafts.delete(chatId)
    pendingEvents.delete(chatId)
    set((s) => {
      const chats = { ...s.chats }
      delete chats[chatId]
      return { chats }
    })
    await window.piDesktop.chat.close({ chatId }).catch(() => {})
  },

  async refresh(chatId) {
    const draft = drafts.get(chatId)
    if (!draft) {
      return
    }
    const result = await window.piDesktop.chat.refresh({ chatId })
    const view = buildChatViewState(result.messages)
    Object.assign(draft, view, {
      cwd: result.cwd || draft.cwd,
      sessionPath: result.sessionPath ?? draft.sessionPath,
      model: result.state.model,
      thinkingLevel: result.state.thinkingLevel,
      availableThinkingLevels: result.thinkingLevels,
      models: result.models,
      commands: result.commands,
      error: undefined,
      stats: undefined,
      uiRequest: undefined
    })
    draft.status = result.state.isStreaming
      ? 'streaming'
      : view.messages.length > 0
        ? view.status
        : 'idle'
    const firstUser = view.messages.find((m) => m.kind === 'user')
    if (firstUser && firstUser.kind === 'user' && firstUser.text.trim()) {
      draft.title = firstUser.text.slice(0, 80)
    }
    publish(chatId)
  },

  async forkFromUserMessage(chatId, userIndex) {
    const draft = drafts.get(chatId)
    if (!draft) {
      return undefined
    }
    const { messages: forkMessages } = await window.piDesktop.chat.getForkMessages({
      chatId
    })
    const entry = forkMessages[userIndex]
    if (!entry) {
      return undefined
    }
    const result = await window.piDesktop.chat.fork({ chatId, entryId: entry.entryId })
    if (result.cancelled) {
      return undefined
    }
    await get().refresh(chatId)
    const refreshed = drafts.get(chatId)
    if (refreshed && typeof result.text === 'string') {
      refreshed.composerSeed = { text: result.text, nonce: ++seedCounter }
      publish(chatId)
    }
    return result.text
  },

  async cloneChat(chatId) {
    const result = await window.piDesktop.chat.clone({ chatId })
    if (result.cancelled) {
      return
    }
    await get().refresh(chatId)
  },

  setChatTitle(chatId, title) {
    const draft = drafts.get(chatId)
    if (draft) {
      draft.title = title
      publish(chatId)
    }
  },

  respondUi(chatId, response) {
    const draft = drafts.get(chatId)
    if (draft) {
      draft.uiRequest = undefined
      publish(chatId)
    }
    void window.piDesktop.chat.respondUi({ chatId, ...response }).catch(() => {})
  }
}))
