import { create } from 'zustand'
import { useAppStore } from './app-store'
import { toast } from './toast-store'
import { dropComposerDraft } from '../lib/composer-drafts'
import { titleFromUserText } from '../../../shared/skill-prefix'
import type {
  ChatOpenResult,
  ChatSendMode,
  ChatSessionStats,
  CuaActivity
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
  /** Known startup blocker parsed from pi stderr (e.g. a retrying MCP server). */
  startupHint?: string
  /** The file transcript has more message entries than are loaded. */
  hasEarlier?: boolean
  /** Message window currently loaded from the session file. */
  transcriptLimit?: number
  /** True once the file-derived transcript was applied for this chat. */
  transcriptApplied?: boolean
  /** A run finished while the chat was not visible; cleared when opened. */
  unread?: boolean
  /** Latest computer-use activity (start or end) for the strip. */
  cuaActivity?: { app?: string; summary: string; phase: 'start' | 'end'; at: number }
  /** True from the first start until 4s after the last end / turn end. */
  cuaActive?: boolean
  /** Service-wide pause state, mirrored from paused/resumed broadcasts. */
  cuaPaused?: boolean
  /** computerUse.enabled changed while open — restart pi on next send. */
  cuaNeedsReload?: boolean
  /** A `!command` is running in this chat's pi. */
  bashRunning?: boolean
}

interface ChatStoreState {
  chats: Record<string, ChatState>
  /** sessionPath → chatId for chats currently open, so session clicks reuse. */
  openSessionChat(sessionPath: string): string | undefined
  ensureChat(chatId: string, input: { cwd?: string; sessionPath?: string }): Promise<void>
  send(chatId: string, message: string, images: ImageContent[] | undefined, mode: ChatSendMode): Promise<void>
  abort(chatId: string): Promise<void>
  /** Run a `!command` in pi's shell; its output joins the next prompt. */
  runBash(chatId: string, command: string): Promise<void>
  abortBash(chatId: string): Promise<void>
  /** Drop pi's queued messages and hand their text back to the composer. */
  clearQueue(chatId: string): Promise<void>
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
  /**
   * Retry: fork at the user message at `userIndex` and immediately re-send
   * that message's text and images (no composer prefill).
   */
  retryFromUserMessage(chatId: string, userIndex: number): Promise<void>
  /** Fork at a specific entry id (e.g. picked in the /fork or /tree modal). */
  forkAtEntry(chatId: string, entryId: string): Promise<string | undefined>
  /** Restart the chat's pi process on the same session and refresh state. */
  reloadChat(chatId: string): Promise<void>
  /** Clone the current session branch; the chat continues on the new session. */
  cloneChat(chatId: string): Promise<void>
  /** Put text into the chat's composer for the user to edit and send. */
  seedComposer(chatId: string, text: string): void
  /** Clear the unread marker when the chat becomes visible. */
  markRead(chatId: string): void
  setChatTitle(chatId: string, title: string): void
  /** Restart the chat's pi on next send (after computerUse.enabled changed). */
  markCuaStale(chatId: string): void
  respondUi(chatId: string, response: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }): void
}

// Mutable per-chat drafts; events are applied immediately but React only sees
// state after an animation-frame flush, so token deltas batch into one render.
const drafts = new Map<string, ChatState>()
const pendingEvents = new Map<string, PiEvent[]>()
/** 4s "keep the strip visible" tail after the last cua end event. */
const cuaTails = new Map<string, ReturnType<typeof setTimeout>>()
let flushScheduled = false
let statsTimer: ReturnType<typeof setTimeout> | null = null

const CUA_TAIL_MS = 4000

function clearCuaTail(chatId: string): void {
  const timer = cuaTails.get(chatId)
  if (timer) {
    clearTimeout(timer)
    cuaTails.delete(chatId)
  }
}

/** Stop showing the strip: cancel the tail and mark the chat inactive. */
function clearCua(draft: ChatState): void {
  clearCuaTail(draft.chatId)
  if (draft.cuaActive) {
    draft.cuaActive = false
  }
}

function handleCuaActivity(activity: CuaActivity): void {
  // Pause state is service-wide; events carry no chatId.
  if (activity.phase === 'paused' || activity.phase === 'resumed') {
    for (const draft of drafts.values()) {
      draft.cuaPaused = activity.phase === 'paused'
      publish(draft.chatId)
    }
    return
  }
  const chatId =
    activity.chatId ??
    (useAppStore.getState().view.kind === 'chat'
      ? (useAppStore.getState().view as { chatId: string }).chatId
      : undefined)
  const draft = chatId ? drafts.get(chatId) : undefined
  if (!draft) {
    return
  }
  draft.cuaActivity = {
    app: activity.app,
    summary: activity.summary,
    phase: activity.phase,
    at: Date.now()
  }
  if (activity.phase === 'start') {
    clearCuaTail(draft.chatId)
    draft.cuaActive = true
  } else {
    // Keep the strip on screen briefly after the last action so a burst of
    // tool calls reads as one continuous activity rather than flickering.
    clearCuaTail(draft.chatId)
    const id = draft.chatId
    cuaTails.set(
      id,
      setTimeout(() => {
        cuaTails.delete(id)
        const current = drafts.get(id)
        if (current) {
          current.cuaActive = false
          publish(id)
        }
      }, CUA_TAIL_MS)
    )
  }
  publish(draft.chatId)
}

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

// ---------------------------------------------------------------------------
// Notifications — the renderer decides when, main shows the native toast.
// ---------------------------------------------------------------------------

function notifyEnabled(): boolean {
  return useAppStore.getState().appSettings.notifications?.enabled !== false
}

function windowFocused(): boolean {
  return typeof document !== 'undefined' && document.hasFocus()
}

/** Rough markdown → plain text for notification bodies. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function lastAssistantText(draft: ChatState): string {
  for (let i = draft.messages.length - 1; i >= 0; i--) {
    const m = draft.messages[i]!
    if (m.kind === 'assistant') {
      return m.blocks
        .filter((b) => b.type === 'text')
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('\n')
        .trim()
    }
  }
  return ''
}

/** A finished run notifies when the chat is off-screen or the window is
 *  unfocused; the body is the last assistant reply (or the error outcome). */
function notifyRunSettled(chatId: string, draft: ChatState): void {
  if (!notifyEnabled()) {
    return
  }
  const errored = draft.status === 'error' || !!draft.error
  const body = errored
    ? 'Stopped with an error'
    : stripMarkdown(lastAssistantText(draft)).slice(0, 120) || 'Run finished'
  void window.piDesktop.app?.notify?.({ chatId, title: draft.title || 'Pi', body })
    .catch(() => {})
}

function notifyUiRequest(chatId: string, draft: ChatState, title?: string): void {
  if (!notifyEnabled()) {
    return
  }
  void window.piDesktop.app?.notify?.({
    chatId,
    title: draft.title || 'Pi',
    body: `Pi needs your input${title ? `: ${title}` : ''}`
  }).catch(() => {})
}

function flushPending(): void {
  flushScheduled = false
  lastFlushAt = performance.now()
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
    // The turn ended — drop the computer-use strip immediately rather than
    // letting the 4s tail linger past the reply.
    if (events.some((e) => e.type === 'agent_end' || e.type === 'agent_settled')) {
      clearCua(draft)
    }
    // A run that settles while the chat isn't on screen leaves an unread
    // marker in the sidebar; opening the chat clears it via markRead().
    // (start+settle can land in the same batch, so key off the event, not
    // the status snapshot before this flush.)
    if (draft.status === 'idle' && events.some((e) => e.type === 'agent_settled')) {
      if (!isVisibleChat(chatId)) {
        draft.unread = true
      }
      if (!isVisibleChat(chatId) || !windowFocused()) {
        notifyRunSettled(chatId, draft)
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
  scheduleFlush()
}

/**
 * Streaming commits are capped at ~30/s: text arrives token by token, so
 * 60Hz re-renders of the transcript cost twice the CPU/GPU for no visible
 * gain. Hidden windows get no rAF at all — flush on a coarse timer there so
 * run-settled notifications still fire while the app is in the background.
 *
 * A visible but unfocused window (pi working while you are in your editor)
 * commits at 10/s: every commit is a frame Chromium composites, and nobody is
 * reading token by token over there. Focus brings the full rate back on the
 * next flush.
 */
const MIN_FLUSH_INTERVAL_MS = 32
const BLURRED_FLUSH_INTERVAL_MS = 100
const HIDDEN_FLUSH_MS = 250
let lastFlushAt = 0

// Tracked from window focus events rather than polled per flush.
let windowActive = typeof document === 'undefined' || document.hasFocus()
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('focus', () => {
    windowActive = true
  })
  window.addEventListener('blur', () => {
    windowActive = false
  })
}

function scheduleFlush(): void {
  if (flushScheduled) {
    return
  }
  flushScheduled = true
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    setTimeout(flushPending, HIDDEN_FLUSH_MS)
    return
  }
  const interval = windowActive ? MIN_FLUSH_INTERVAL_MS : BLURRED_FLUSH_INTERVAL_MS
  // Clamped: a clock jump (sleep/resume) must never stall the transcript.
  const wait = Math.min(interval, interval - (performance.now() - lastFlushAt))
  if (wait > 8) {
    setTimeout(() => requestAnimationFrame(flushPending), wait - 8)
  } else {
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
    draft.startupHint = undefined
    if (draft.status === 'starting') {
      draft.status = ready.state.isStreaming ? 'streaming' : 'idle'
    }
    clearQueuedFlags(draft)
    publish(ready.chatId)
  })

  window.piDesktop.chat.onStartupHint(({ chatId, hint }) => {
    const draft = drafts.get(chatId)
    if (!draft || draft.piReady) {
      return
    }
    draft.startupHint = hint
    publish(chatId)
  })

  window.piDesktop.cua?.onActivity(handleCuaActivity)

  window.piDesktop.chat.onUiRequest(({ chatId, request }) => {
    const draft = drafts.get(chatId)
    if (draft) {
      draft.uiRequest = request
      publish(chatId)
      if (
        (request.method === 'confirm' ||
          request.method === 'select' ||
          request.method === 'input' ||
          request.method === 'editor') &&
        (!isVisibleChat(chatId) || !windowFocused())
      ) {
        notifyUiRequest(chatId, draft, request.title)
      }
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
  draft.startupHint = undefined
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
    let draft = drafts.get(chatId)
    if (!draft) {
      throw new Error('Chat is not open')
    }
    // computerUse.enabled is read when pi spawns its extension — a toggle on
    // an open chat takes effect on the next send by restarting the process.
    // A send while streaming/starting is a steer and must not kill the run;
    // the flag stays set and the next idle send reloads instead.
    if (draft.cuaNeedsReload && draft.status !== 'streaming' && draft.status !== 'starting') {
      draft.cuaNeedsReload = undefined
      await get().reloadChat(chatId).catch(() => {})
      draft = drafts.get(chatId)
      if (!draft) {
        throw new Error('Chat is not open')
      }
    }
    // A message sent mid-run waits in pi's queue: it shows in the queue strip
    // above the composer and joins the transcript when pi delivers it (the
    // user-message echo), not before. queue_update replaces this guess.
    const queued = draft.status === 'streaming' && (mode === 'steer' || mode === 'followUp')
    if (queued) {
      const queue = draft.queue ?? { steering: [], followUp: [] }
      draft.queue =
        mode === 'steer'
          ? { ...queue, steering: [...queue.steering, message] }
          : { ...queue, followUp: [...queue.followUp, message] }
      publish(chatId)
      try {
        await window.piDesktop.chat.send({ chatId, message, images, mode })
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Could not queue the message')
        throw error
      }
      return
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
    // A fresh prompt starts the run clock (steer/follow-up keep the current one).
    if (draft.status !== 'streaming') {
      draft.runStartedAt = Date.now()
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
    const draft = drafts.get(chatId)
    if (draft) {
      clearCua(draft)
      publish(chatId)
    }
    await window.piDesktop.chat.abort({ chatId })
  },

  async runBash(chatId, command) {
    const draft = drafts.get(chatId)
    if (!draft || draft.bashRunning) {
      return
    }
    const key = `local-bash-${++optimisticCounter}`
    draft.messages.push({
      kind: 'bash',
      key,
      command,
      output: '',
      running: true,
      timestamp: Date.now()
    })
    draft.bashRunning = true
    publish(chatId)
    const settle = (patch: Partial<Extract<DisplayMessage, { kind: 'bash' }>>): void => {
      const current = drafts.get(chatId)
      if (!current) {
        return
      }
      current.bashRunning = false
      const index = current.messages.findIndex((m) => m.key === key)
      const row = current.messages[index]
      if (row?.kind === 'bash') {
        current.messages[index] = { ...row, ...patch, running: false }
      }
      publish(chatId)
    }
    try {
      const result = await window.piDesktop.chat.bash({ chatId, command })
      settle({
        output: result.output,
        exitCode: result.exitCode,
        cancelled: result.cancelled
      })
    } catch (error) {
      settle({
        output: error instanceof Error ? error.message : String(error),
        exitCode: 1
      })
    }
  },

  async abortBash(chatId) {
    await window.piDesktop.chat.abortBash({ chatId }).catch(() => {})
  },

  async clearQueue(chatId) {
    const draft = drafts.get(chatId)
    if (!draft) {
      return
    }
    const local = draft.queue
    const result = await window.piDesktop.chat.clearQueue({ chatId }).catch(() => null)
    const current = drafts.get(chatId)
    if (!current) {
      return
    }
    delete current.queue
    // Hand the text back for editing instead of dropping it on the floor.
    const texts = result
      ? [...result.steering, ...result.followUp]
      : [...(local?.steering ?? []), ...(local?.followUp ?? [])]
    if (texts.length > 0) {
      current.composerSeed = { text: texts.join('\n\n'), nonce: ++seedCounter }
    }
    publish(chatId)
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
    draft.startupHint = undefined
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
    clearCuaTail(chatId)
    drafts.delete(chatId)
    dropComposerDraft(chatId)
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

  async retryFromUserMessage(chatId, userIndex) {
    const draft = drafts.get(chatId)
    if (!draft) {
      return
    }
    const user = draft.messages.filter((m) => m.kind === 'user')[userIndex]
    if (!user || user.kind !== 'user') {
      return
    }
    const text = user.text
    const images = user.images.length ? user.images : undefined
    const forked = await get().forkFromUserMessage(chatId, userIndex)
    if (forked === undefined) {
      return
    }
    // forkFromUserMessage seeds the composer for editing; retry sends right
    // away, so clear the seed to leave an empty composer.
    const refreshed = drafts.get(chatId)
    if (refreshed?.composerSeed) {
      refreshed.composerSeed = { text: '', nonce: ++seedCounter }
      publish(chatId)
    }
    await get().send(chatId, text, images, 'prompt')
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

  seedComposer(chatId, text) {
    const draft = drafts.get(chatId)
    if (draft) {
      draft.composerSeed = { text, nonce: ++seedCounter }
      publish(chatId)
    }
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

  /** Flag that the chat's pi must restart before the next send (setting
   *  applied at process spawn). */
  markCuaStale(chatId) {
    const draft = drafts.get(chatId)
    if (draft) {
      draft.cuaNeedsReload = true
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


