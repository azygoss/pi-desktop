import { create } from 'zustand'
import { useAppStore } from './app-store'
import { titleFromUserText } from '../../../shared/skill-prefix'
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
  /** Last stderr lines from an exited pi process, shown behind "Show details". */
  stderrTail?: string[]
  uiRequest?: ExtensionUiRequest
  /** Text handed back by fork for the composer to preload (nonce bumps each time). */
  composerSeed?: { text: string; nonce: number }
  /** pi answered its first requests; false while the process is starting. */
  piReady?: boolean
  /** When the pi spawn began — drives the "Starting pi… Ns" indicator. */
  startedAt?: number
  /** The file transcript has more message entries than are loaded. */
  hasEarlier?: boolean
  /** Message window currently loaded from the session file. */
  transcriptLimit?: number
  /** True once the file-derived transcript was applied for this chat. */
  transcriptApplied?: boolean
  /** A run finished while the chat was not visible; cleared when opened. */
  unread?: boolean
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
  /** Widen the file-transcript window ("Load earlier" for long sessions). */
  loadEarlier(chatId: string): Promise<void>
  /**
   * Fork the session at the user message at `userIndex` (position among user
   * messages). Returns the message text pi hands back for editing.
   */
  forkFromUserMessage(chatId: string, userIndex: number): Promise<string | undefined>
  /** Fork at a specific entry id (e.g. picked in the /fork or /tree modal). */
  forkAtEntry(chatId: string, entryId: string): Promise<string | undefined>
  /** Restart the chat's pi process on the same session and refresh state. */
  reloadChat(chatId: string): Promise<void>
  /** Clone the current session branch; the chat continues on the new session. */
  cloneChat(chatId: string): Promise<void>
  /** Clear the unread marker when the chat becomes visible. */
  markRead(chatId: string): void
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

function isVisibleChat(chatId: string): boolean {
  const view = useAppStore.getState().view
  return view.kind === 'chat' && view.chatId === chatId
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
    // A run that settles while the chat isn't on screen leaves an unread
    // marker in the sidebar; opening the chat clears it via markRead().
    // (start+settle can land in the same batch, so key off the event, not
    // the status snapshot before this flush.)
    if (
      draft.status === 'idle' &&
      !isVisibleChat(chatId) &&
      events.some((e) => e.type === 'agent_settled')
    ) {
      draft.unread = true
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

  window.piDesktop.chat.onEvent(({ chatId, events }) => {
    for (const event of events) {
      enqueueEvent(chatId, event)
    }
  })

  // Live catalog/state the moment the chat's pi process answers — replaces
  // whatever cached values were shown while it was starting.
  window.piDesktop.chat.onReady((ready) => {
    const draft = drafts.get(ready.chatId)
    if (!draft) {
      return
    }
    draft.piReady = true
    draft.models = ready.models
    draft.commands = ready.commands
    draft.model = ready.state.model ?? draft.model
    draft.thinkingLevel = ready.state.thinkingLevel ?? draft.thinkingLevel
    draft.availableThinkingLevels = ready.thinkingLevels
    if (ready.sessionPath && !draft.sessionPath) {
      draft.sessionPath = ready.sessionPath
    }
    if (draft.status === 'starting') {
      draft.status = ready.state.isStreaming ? 'streaming' : 'idle'
    }
    clearQueuedFlags(draft)
    publish(ready.chatId)
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
    // Kept separate from the headline so the UI can hide it behind a
    // "Show details" expander instead of dumping stderr into the bubble.
    draft.stderrTail = stderrTail.length > 0 ? stderrTail : undefined
    publish(chatId)
  })
}

/**
 * Apply a resolved `chat.open` result to a draft. The file-derived
 * transcript stays the display source when it loaded; the RPC message list
 * only fills in when there was nothing to show.
 */
function applyOpenResult(
  chatId: string,
  draft: ChatState,
  result: ChatOpenResult,
  input: { cwd?: string; sessionPath?: string }
): void {
  const view = buildChatViewState(result.messages)
  if (!draft.transcriptApplied || draft.messages.length === 0) {
    draft.messages = view.messages
    draft.toolRuns = view.toolRuns
  }
  draft.piReady = true
  if (result.state.isStreaming) {
    draft.status = 'streaming'
  } else if (draft.status === 'starting') {
    draft.status = 'idle'
  }
  draft.error = undefined
  draft.stderrTail = undefined
  draft.model = result.state.model
  draft.thinkingLevel = result.state.thinkingLevel
  draft.availableThinkingLevels = result.thinkingLevels
  draft.models = result.models
  draft.commands = result.commands
  // For session opens the recorded cwd is authoritative; for cwd opens the
  // draft's cwd wins — it may have been switched (setCwd) while this open
  // was in flight. A session-open draft starts with an empty cwd, so a
  // non-empty cwd here means the user picked a project mid-open.
  if (input.sessionPath !== undefined && !draft.cwd) {
    draft.cwd = result.cwd || draft.cwd
  }
  draft.sessionPath = result.sessionPath ?? input.sessionPath ?? draft.sessionPath
  if (!draft.transcriptApplied) {
    const firstUser = view.messages.find((m) => m.kind === 'user')
    if (firstUser && firstUser.kind === 'user' && firstUser.text.trim()) {
      draft.title = (titleFromUserText(firstUser.text) ?? '').slice(0, 80)
    }
  }
  clearQueuedFlags(draft)
  publish(chatId)
}

/**
 * Drop the "queued — waiting for pi" marker once the process answered.
 * Replaces message objects so memoized rows re-render.
 */
function clearQueuedFlags(draft: ChatState): void {
  for (let i = 0; i < draft.messages.length; i++) {
    const message = draft.messages[i]!
    if (message.kind === 'user' && message.queued) {
      draft.messages[i] = { ...message, queued: false }
    }
  }
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
    if (
      existing &&
      existing.status !== 'starting' &&
      existing.status !== 'error' &&
      existing.status !== 'exited'
    ) {
      return
    }
    if (existing) {
      // Retry after a failed start or a dead process: keep transcript/title.
      existing.status = 'starting'
      existing.error = undefined
      existing.stderrTail = undefined
      existing.piReady = false
      existing.startedAt = Date.now()
      publish(chatId)
      const retry: ChatOpenResult | void = await window.piDesktop.chat
        .open({ chatId, cwd: existing.cwd || input.cwd, sessionPath: existing.sessionPath ?? input.sessionPath })
        .catch((error: unknown) => {
          // 'Chat closed' means a newer open (project switch, reload) or a
          // real close superseded this one — it owns the draft state now.
          const message = error instanceof Error ? error.message : String(error)
          if (message !== 'Chat closed' && drafts.has(chatId)) {
            existing.status = 'error'
            existing.error = message
            publish(chatId)
          }
        })
      if (retry) {
        applyOpenResult(chatId, existing, retry, input)
      }
      return
    }
    const draft: ChatState = {
      ...createChatViewState(),
      chatId,
      cwd: input.cwd ?? '',
      sessionPath: input.sessionPath,
      title: 'New chat',
      status: 'starting',
      piReady: false,
      startedAt: Date.now(),
      model: null,
      thinkingLevel: null,
      availableThinkingLevels: [],
      models: [],
      commands: []
    }
    drafts.set(chatId, draft)
    publish(chatId)

    // Instant transcript: read the session file in main and render the
    // active branch while pi is still starting in the background.
    if (input.sessionPath) {
      void window.piDesktop.chat
        .readTranscript({ sessionPath: input.sessionPath })
        .then((transcript) => {
          const current = drafts.get(chatId)
          if (!current) {
            return
          }
          const view = buildChatViewState(transcript.messages)
          current.messages = view.messages
          current.toolRuns = view.toolRuns
          current.hasEarlier = transcript.hasEarlier
          current.transcriptLimit = transcript.messages.length || undefined
          current.transcriptApplied = true
          const firstUser = view.messages.find((m) => m.kind === 'user')
          if (firstUser && firstUser.kind === 'user' && firstUser.text.trim()) {
            current.title =
              titleFromUserText(firstUser.text)
                ?.replace(/\s+/g, ' ')
                .trim()
                .slice(0, 80) ?? current.title
          }
          publish(chatId)
        })
        .catch(() => {})
    }

    // Cached catalog: the composer and palette show last-known models and
    // commands immediately; the ready broadcast replaces them with live data.
    void window.piDesktop.catalog
      .get()
      .then((catalog) => {
        const current = drafts.get(chatId)
        if (!current || current.piReady) {
          return
        }
        current.models = catalog.models
        current.commands = catalog.commands
        current.availableThinkingLevels = catalog.thinkingLevels
        current.model = catalog.model ?? current.model
        current.thinkingLevel = catalog.thinkingLevel ?? current.thinkingLevel
        publish(chatId)
      })
      .catch(() => {})

    let result: ChatOpenResult
    try {
      result = await window.piDesktop.chat.open({
        chatId,
        cwd: input.cwd,
        sessionPath: input.sessionPath
      })
    } catch (error) {
      const current = drafts.get(chatId)
      const message = error instanceof Error ? error.message : String(error)
      // A superseded open reports 'Chat closed'; the replacement open (e.g.
      // a project switch via setCwd) owns the draft's status.
      if (current && message !== 'Chat closed') {
        current.status = 'error'
        current.error = message
        publish(chatId)
      }
      throw error
    }

    const current = drafts.get(chatId)
    if (!current) {
      return // closed while opening
    }
    applyOpenResult(chatId, current, result, input)
  },

  async loadEarlier(chatId) {
    const draft = drafts.get(chatId)
    if (!draft?.sessionPath) {
      return
    }
    const limit = (draft.transcriptLimit ?? 0) + 2000
    const transcript = await window.piDesktop.chat.readTranscript({
      sessionPath: draft.sessionPath,
      limit
    })
    const current = drafts.get(chatId)
    if (!current) {
      return
    }
    const view = buildChatViewState(transcript.messages)
    // The wider window is a superset of the loaded tail; live tool runs
    // that arrived after the transcript was read are merged back over it.
    current.messages = view.messages
    current.toolRuns = { ...view.toolRuns, ...current.toolRuns }
    current.hasEarlier = transcript.hasEarlier
    current.transcriptLimit = transcript.messages.length || undefined
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
      // Sent before pi answered — main queues it until the process is ready.
      ...(draft.piReady === false ? { queued: true } : {}),
      timestamp: Date.now()
    }
    draft.messages.push(display)
    if (draft.title === 'New chat' && message.trim()) {
      draft.title = (titleFromUserText(message) ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
    }
    // Still starting → keep the "Starting pi" status; the send is queued.
    draft.status = draft.piReady === false ? 'starting' : 'streaming'
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
    if (!draft) {
      return
    }
    // Apply the selection immediately: restarting pi takes seconds, and the
    // chip should reflect the picked project right away while the process
    // warms in the background (sends queue until it is ready).
    const previousCwd = draft.cwd
    draft.cwd = cwd
    draft.status = 'starting'
    draft.piReady = false
    draft.startedAt = Date.now()
    draft.error = undefined
    draft.stderrTail = undefined
    publish(chatId)
    let result: ChatOpenResult
    try {
      result = await window.piDesktop.chat.setCwd({ chatId, cwd })
    } catch (error) {
      // Reopen failed (e.g. the folder vanished) — restore the old project
      // and surface the error instead of leaving a stale selection.
      if (!drafts.has(chatId)) {
        return
      }
      draft.cwd = previousCwd
      draft.status = 'error'
      draft.error = error instanceof Error ? error.message : String(error)
      publish(chatId)
      return
    }
    if (!drafts.has(chatId)) {
      return // closed while switching
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
    draft.piReady = true
    draft.status = result.state.isStreaming ? 'streaming' : 'idle'
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
      // refresh never changes the project; keep draft.cwd so a concurrent
      // setCwd isn't undone by a stale result.
      cwd: draft.cwd,
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
    return get().forkAtEntry(chatId, entry.entryId)
  },

  async forkAtEntry(chatId, entryId) {
    const result = await window.piDesktop.chat.fork({ chatId, entryId })
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

  async reloadChat(chatId) {
    const draft = drafts.get(chatId)
    if (!draft) {
      return
    }
    const result = await window.piDesktop.chat.reload({ chatId })
    const current = drafts.get(chatId)
    if (!current) {
      return
    }
    const view = buildChatViewState(result.messages)
    Object.assign(current, view, {
      // reload never changes the project; keep the draft cwd so a concurrent
      // setCwd isn't undone by a stale result.
      cwd: current.cwd,
      sessionPath: result.sessionPath ?? current.sessionPath,
      model: result.state.model,
      thinkingLevel: result.state.thinkingLevel,
      availableThinkingLevels: result.thinkingLevels,
      models: result.models,
      commands: result.commands,
      error: undefined,
      stats: undefined,
      uiRequest: undefined
    })
    current.status = result.state.isStreaming ? 'streaming' : 'idle'
    publish(chatId)
  },

  async cloneChat(chatId) {
    const result = await window.piDesktop.chat.clone({ chatId })
    if (result.cancelled) {
      return
    }
    await get().refresh(chatId)
  },

  markRead(chatId) {
    const draft = drafts.get(chatId)
    if (draft?.unread) {
      draft.unread = false
      publish(chatId)
    }
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
