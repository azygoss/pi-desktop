import { randomUUID } from 'expo-crypto'
import { AppState } from 'react-native'
import { create } from 'zustand'

import {
  buildChatViewState,
  createChatViewState,
  reducePiEvent,
  titleFromUserText,
  type ChatEventPayload,
  type ChatExitPayload,
  type ChatOpenResult,
  type ChatReadyPayload,
  type ChatSendMode,
  type ChatSessionStats,
  type ChatStartupHintPayload,
  type ChatUiRequestPayload,
  type ChatViewState,
  type CuaActivity,
  type DisplayMessage,
  type ExtensionUiRequest,
  type ImageContent,
  type Model,
  type PiCommandInfo,
  type PiEvent,
  type ThinkingLevel
} from '../desktop'
import { api, errorText, EVENTS } from '../remote/api'
import { toast } from '../ui'
import { haptic } from '../ui'
import { onOnline, onRemote, onUnpair, subscribeChats } from './connection'
import { useData } from './data'
import type { RemoteLiveChat } from '../desktop'

/** Messages read from the session file when a chat opens / per "Load earlier". */
const TRANSCRIPT_PAGE = 80
/** Chats whose token stream stays subscribed (most recently opened first). */
const MAX_SUBSCRIBED = 12
/** Chats kept in memory; older idle ones are dropped and reopen from the list. */
const MAX_OPEN = 16
const CHECKPOINT_TIMEOUT_MS = 4000

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
  stderrTail?: string[]
  uiRequest?: ExtensionUiRequest
  /** Text for the composer to take over (nonce bumps each time). */
  composerSeed?: { text: string; nonce: number }
  /** pi answered its first requests; false while the process is starting. */
  piReady?: boolean
  startedAt?: number
  startupHint?: string
  /** The session file has more messages than are loaded. */
  hasEarlier?: boolean
  transcriptLimit?: number
  transcriptApplied?: boolean
  /** A run finished while this chat was not on screen. */
  unread?: boolean
  cuaActivity?: { app?: string; summary: string; phase: 'start' | 'end'; at: number }
  cuaActive?: boolean
  cuaPaused?: boolean
  bashRunning?: boolean
  /**
   * Events may have been missed (the link dropped, or the chat fell out of
   * the subscription window): re-read it before it is shown again.
   */
  stale?: boolean
}

interface ChatStoreState {
  chats: Record<string, ChatState>
  /** Open (or join) the chat for a session file; resolves to its chat id. */
  openSession(sessionPath: string): Promise<string>
  /** Join a chat that is live on the computer (it may have no session file yet). */
  joinLive(chatId: string, cwd: string, sessionPath?: string): string
  /** Start a draft chat in a project folder. */
  newChat(cwd: string): string
  send(chatId: string, message: string, images: ImageContent[] | undefined, mode: ChatSendMode): Promise<void>
  abort(chatId: string): Promise<void>
  runBash(chatId: string, command: string): Promise<void>
  abortBash(chatId: string): Promise<void>
  clearQueue(chatId: string): Promise<void>
  setModel(chatId: string, provider: string, modelId: string): Promise<void>
  setThinkingLevel(chatId: string, level: ThinkingLevel): Promise<void>
  setCwd(chatId: string, cwd: string): Promise<void>
  /** Re-read state and messages from pi (after fork / clone / compact). */
  refresh(chatId: string): Promise<void>
  loadEarlier(chatId: string): Promise<void>
  forkAtEntry(chatId: string, entryId: string): Promise<string | undefined>
  forkFromUserMessage(chatId: string, userIndex: number): Promise<string | undefined>
  retryFromUserMessage(chatId: string, userIndex: number): Promise<void>
  reloadChat(chatId: string): Promise<void>
  cloneChat(chatId: string): Promise<void>
  compact(chatId: string, instructions?: string): Promise<void>
  rename(chatId: string, name: string): Promise<void>
  seedComposer(chatId: string, text: string): void
  /** The chat on screen (null when none): drives unread marks. */
  setVisible(chatId: string | null): void
  respondUi(chatId: string, response: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }): void
  retryOpen(chatId: string): void
}

// Mutable per-chat drafts: events apply to them at once, React sees a fresh
// reference at most ~20 times a second (4 while the app is in the background).
const drafts = new Map<string, ChatState>()
const pendingEvents = new Map<string, PiEvent[]>()
const openOrder: string[] = []
const cuaTails = new Map<string, ReturnType<typeof setTimeout>>()
/** Session opens still asking the computer who owns the session. */
const opening = new Map<string, Promise<string>>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let lastFlushAt = 0
let statsTimer: ReturnType<typeof setTimeout> | null = null
const statsDirty = new Set<string>()
let visibleChatId: string | null = null
let optimisticCounter = 0
let seedCounter = 0

const FLUSH_INTERVAL_MS = 50
const BACKGROUND_FLUSH_MS = 250
const CUA_TAIL_MS = 4000

/** Called when a background chat finishes, to offer opening it. */
let openChatHandler: ((chatId: string) => void) | null = null
export function setOpenChatHandler(handler: ((chatId: string) => void) | null): void {
  openChatHandler = handler
}

function publish(chatId: string): void {
  const draft = drafts.get(chatId)
  if (!draft) {
    return
  }
  useChats.setState((s) => ({
    chats: {
      ...s.chats,
      [chatId]: { ...draft, messages: draft.messages.slice(), toolRuns: { ...draft.toolRuns } }
    }
  }))
}

function touchSubscription(chatId: string): void {
  const at = openOrder.indexOf(chatId)
  if (at >= 0) {
    openOrder.splice(at, 1)
  }
  openOrder.unshift(chatId)
  // A long day opens many chats: let go of the oldest that are at rest.
  for (let i = openOrder.length - 1; i >= MAX_OPEN; i--) {
    const old = drafts.get(openOrder[i]!)
    if (old && (old.status === 'streaming' || old.unread || old.bashRunning || old.chatId === visibleChatId)) {
      continue
    }
    const [dropped] = openOrder.splice(i, 1)
    if (dropped) {
      drafts.delete(dropped)
      pendingEvents.delete(dropped)
      useChats.setState((s) => {
        const chats = { ...s.chats }
        delete chats[dropped]
        return { chats }
      })
    }
  }
  // Past the window a chat only hears that runs start and settle.
  for (let i = MAX_SUBSCRIBED; i < openOrder.length; i++) {
    const beyond = drafts.get(openOrder[i]!)
    if (beyond) {
      beyond.stale = true
    }
  }
  subscribeChats(openOrder.slice(0, MAX_SUBSCRIBED))
  if (drafts.get(chatId)?.stale) {
    void resync(chatId)
  }
}

function titleOf(messages: DisplayMessage[]): string | undefined {
  const firstUser = messages.find((m) => m.kind === 'user')
  if (firstUser?.kind === 'user' && firstUser.text.trim()) {
    return titleFromUserText(firstUser.text)?.replace(/\s+/g, ' ').trim().slice(0, 80)
  }
  return undefined
}

function sessionTitle(sessionPath: string | undefined): string | undefined {
  return sessionPath
    ? useData.getState().sessions.find((s) => s.path === sessionPath)?.title
    : undefined
}

function clearQueuedFlags(draft: ChatState): void {
  for (let i = 0; i < draft.messages.length; i++) {
    const message = draft.messages[i]!
    if (message.kind === 'user' && message.queued) {
      draft.messages[i] = { ...message, queued: false }
    }
  }
}

function clearCua(draft: ChatState): void {
  const timer = cuaTails.get(draft.chatId)
  if (timer) {
    clearTimeout(timer)
    cuaTails.delete(draft.chatId)
  }
  draft.cuaActive = false
}

function flushPending(): void {
  flushTimer = null
  lastFlushAt = Date.now()
  for (const [chatId, events] of pendingEvents) {
    const draft = drafts.get(chatId)
    if (!draft) {
      continue
    }
    for (const event of events) {
      if (reducePiEvent(draft, event)) {
        statsDirty.add(chatId)
      }
    }
    const settled = events.some((e) => e.type === 'agent_settled')
    if (settled || events.some((e) => e.type === 'agent_end')) {
      clearCua(draft)
    }
    if (settled && draft.status === 'idle') {
      if (visibleChatId === chatId) {
        haptic('success')
      } else {
        draft.unread = true
        const id = chatId
        toast(`${draft.title || 'Chat'} finished`, {
          action: { label: 'Open', run: () => openChatHandler?.(id) }
        })
      }
    }
    publish(chatId)
  }
  pendingEvents.clear()
  if (statsDirty.size > 0) {
    scheduleStats()
  }
}

function scheduleFlush(): void {
  if (flushTimer) {
    return
  }
  const interval = AppState.currentState === 'active' ? FLUSH_INTERVAL_MS : BACKGROUND_FLUSH_MS
  flushTimer = setTimeout(flushPending, Math.max(0, interval - (Date.now() - lastFlushAt)))
}

function scheduleStats(): void {
  if (statsTimer) {
    clearTimeout(statsTimer)
  }
  statsTimer = setTimeout(() => {
    statsTimer = null
    // Only the chats that just ran: asking an idle chat for stats would
    // wake a pi process the computer had put to sleep.
    const dirty = [...statsDirty]
    statsDirty.clear()
    for (const chatId of dirty) {
      const draft = drafts.get(chatId)
      if (draft?.piReady && (draft.status === 'idle' || draft.status === 'streaming')) {
        void refreshStats(chatId)
      }
    }
  }, 200)
}

async function refreshStats(chatId: string): Promise<void> {
  const stats = await api.chat.stats(chatId).catch(() => undefined)
  const current = drafts.get(chatId)
  if (current && stats) {
    current.stats = stats
    if (stats.sessionFile && !current.sessionPath) {
      current.sessionPath = stats.sessionFile
    }
    publish(chatId)
  }
}

function applyCatalog(draft: ChatState, result: ChatOpenResult): void {
  draft.piReady = true
  draft.error = undefined
  draft.stderrTail = undefined
  draft.startupHint = undefined
  draft.model = result.state.model
  draft.thinkingLevel = result.state.thinkingLevel
  draft.availableThinkingLevels = result.thinkingLevels
  draft.models = result.models
  draft.commands = result.commands
  draft.cwd = result.cwd || draft.cwd
  draft.sessionPath = result.sessionPath ?? draft.sessionPath
  if (result.state.isStreaming) {
    draft.status = 'streaming'
    draft.runStartedAt ??= Date.now()
  } else if (draft.status === 'starting' || draft.status === 'error' || draft.status === 'exited') {
    draft.status = 'idle'
  }
  clearQueuedFlags(draft)
}

/**
 * Render the tail of the session file: instant, and independent of pi.
 * `authoritative` is for catching up after missed events: whatever the phone
 * assembled from the stream is dropped in favor of the file.
 */
async function applyTranscript(
  chatId: string,
  sessionPath: string,
  limit: number,
  authoritative = false
): Promise<void> {
  const transcript = await api.chat.transcript(sessionPath, limit)
  const current = drafts.get(chatId)
  if (!current) {
    return
  }
  const view = buildChatViewState(transcript.messages)
  if (authoritative) {
    pendingEvents.delete(chatId)
    current.messages = view.messages
    current.toolRuns = view.toolRuns
  } else {
    // A message pi is streaming right now is not in the file yet: keep it.
    const last = current.messages[current.messages.length - 1]
    const streaming = last?.kind === 'assistant' && last.streaming ? last : undefined
    current.messages = streaming ? [...view.messages, streaming] : view.messages
    current.toolRuns = { ...view.toolRuns, ...current.toolRuns }
  }
  current.hasEarlier = transcript.hasEarlier
  current.transcriptLimit = Math.max(limit, transcript.messages.length)
  current.transcriptApplied = true
  current.title = sessionTitle(sessionPath) ?? titleOf(view.messages) ?? current.title
  publish(chatId)
}

/** What the computer says about a chat right now: running, waiting on the user. */
function applyLive(draft: ChatState, live: RemoteLiveChat | undefined): void {
  const request = live?.uiRequest as ExtensionUiRequest | undefined
  draft.uiRequest = request
  if (live?.streaming) {
    draft.status = 'streaming'
    draft.runStartedAt ??= Date.now()
  } else if (draft.status === 'streaming') {
    draft.status = 'idle'
    delete draft.runStartedAt
    delete draft.queue
  }
  if (live?.sessionPath && !draft.sessionPath) {
    draft.sessionPath = live.sessionPath
  }
}

async function liveChat(chatId: string): Promise<RemoteLiveChat | undefined> {
  await useData.getState().refreshLive()
  return useData.getState().live[chatId]
}

/**
 * Catch a chat up after events were missed, without waking its pi: the
 * transcript comes from the session file and its state from the computer's
 * list of live chats.
 */
async function resync(chatId: string): Promise<void> {
  const draft = drafts.get(chatId)
  if (!draft) {
    return
  }
  draft.stale = false
  try {
    const live = await liveChat(chatId)
    const current = drafts.get(chatId)
    if (!current) {
      return
    }
    applyLive(current, live)
    if (!live) {
      // Not running on the computer any more; the next send reopens it.
      clearCua(current)
    }
    publish(chatId)
    const sessionPath = current.sessionPath
    if (sessionPath) {
      await applyTranscript(chatId, sessionPath, current.transcriptLimit ?? TRANSCRIPT_PAGE, true)
    }
  } catch {
    const current = drafts.get(chatId)
    if (current) {
      current.stale = true // offline again: try when it is next shown
    }
  }
}

function createDraft(chatId: string, input: { cwd?: string; sessionPath?: string }): ChatState {
  const draft: ChatState = {
    ...createChatViewState(),
    chatId,
    cwd: input.cwd ?? '',
    sessionPath: input.sessionPath,
    title: sessionTitle(input.sessionPath) ?? 'New chat',
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
  touchSubscription(chatId)
  publish(chatId)
  return draft
}

/**
 * Bring a chat up: the session file's tail renders first, then pi answers
 * with its state. `live` chats already run on the computer and are joined;
 * the rest get a pi process of their own.
 */
async function bringUp(
  chatId: string,
  input: { cwd?: string; sessionPath?: string; live?: boolean }
): Promise<void> {
  const draft = drafts.get(chatId)
  if (!draft) {
    return
  }
  draft.status = draft.messages.length > 0 && draft.piReady ? draft.status : 'starting'
  draft.error = undefined
  draft.startedAt = Date.now()
  publish(chatId)

  if (input.sessionPath) {
    void applyTranscript(chatId, input.sessionPath, draft.transcriptLimit ?? TRANSCRIPT_PAGE).catch(
      () => {}
    )
  }
  // Last-known models and commands, so the composer is usable while pi starts.
  void api.app
    .catalog()
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
    result = input.live
      ? await api.chat.refresh(chatId).catch(() =>
          // It stopped in the meantime: start it under the same id.
          api.chat.open({ chatId, cwd: input.cwd, sessionPath: input.sessionPath })
        )
      : await api.chat.open({ chatId, cwd: input.cwd, sessionPath: input.sessionPath })
  } catch (error) {
    const current = drafts.get(chatId)
    if (current) {
      current.status = 'error'
      current.error = errorText(error)
      publish(chatId)
    }
    return
  }
  const current = drafts.get(chatId)
  if (!current) {
    return
  }
  applyCatalog(current, result)
  publish(chatId)
  // A chat joined by id alone learns its session file from pi.
  if (!current.transcriptApplied && current.sessionPath && (input.live || input.sessionPath)) {
    void applyTranscript(chatId, current.sessionPath, TRANSCRIPT_PAGE).catch(() => {})
  }
  void refreshStats(chatId)
  // A question pi asked before this phone opened the chat.
  if (input.live) {
    void liveChat(chatId)
      .then((live) => {
        const joined = drafts.get(chatId)
        if (joined && live?.uiRequest && !joined.uiRequest) {
          joined.uiRequest = live.uiRequest as ExtensionUiRequest
          publish(chatId)
        }
      })
      .catch(() => {})
  }
}

/** Run a chat request; if the computer no longer runs this chat, reopen it once. */
async function withRevive<T>(chatId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const draft = drafts.get(chatId)
    if (!draft || !/No running pi process/.test(errorText(error))) {
      throw error
    }
    const result = await api.chat.open({
      chatId,
      ...(draft.sessionPath ? { sessionPath: draft.sessionPath } : { cwd: draft.cwd })
    })
    applyCatalog(draft, result)
    publish(chatId)
    return run()
  }
}

async function takeCheckpoint(cwd: string): Promise<string | null> {
  if (!cwd) {
    return null
  }
  return Promise.race([
    api.checkpoints.create(cwd).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), CHECKPOINT_TIMEOUT_MS))
  ])
}

export const useChats = create<ChatStoreState>((_set, get) => ({
  chats: {},

  async openSession(sessionPath) {
    for (const draft of drafts.values()) {
      if (draft.sessionPath === sessionPath) {
        touchSubscription(draft.chatId)
        if (draft.status === 'error' || draft.status === 'exited') {
          void bringUp(draft.chatId, { sessionPath })
        }
        return draft.chatId
      }
    }
    // A second tap while the first is still asking the computer.
    const pending = opening.get(sessionPath)
    if (pending) {
      return pending
    }
    const open = (async () => {
      // The computer (or its window) may already run this session: join it.
      const liveId = await api.chat.idForSession(sessionPath).catch(() => undefined)
      const chatId = liveId ?? randomUUID()
      if (!drafts.has(chatId)) {
        createDraft(chatId, { sessionPath })
        void bringUp(chatId, { sessionPath, live: liveId !== undefined })
      }
      return chatId
    })()
    opening.set(sessionPath, open)
    try {
      return await open
    } finally {
      opening.delete(sessionPath)
    }
  },

  joinLive(chatId, cwd, sessionPath) {
    if (!drafts.has(chatId)) {
      createDraft(chatId, { cwd, sessionPath })
      void bringUp(chatId, { cwd, sessionPath, live: true })
    } else {
      touchSubscription(chatId)
    }
    return chatId
  },

  newChat(cwd) {
    const chatId = randomUUID()
    createDraft(chatId, { cwd })
    void bringUp(chatId, { cwd })
    return chatId
  },

  retryOpen(chatId) {
    const draft = drafts.get(chatId)
    if (draft) {
      void bringUp(chatId, {
        ...(draft.sessionPath ? { sessionPath: draft.sessionPath } : { cwd: draft.cwd })
      })
    }
  },

  async send(chatId, message, images, mode) {
    const draft = drafts.get(chatId)
    if (!draft) {
      throw new Error('Chat is not open')
    }
    // Sent mid-run: it waits in pi's queue (the strip above the composer) and
    // joins the transcript when pi delivers it.
    if (draft.status === 'streaming' && (mode === 'steer' || mode === 'followUp')) {
      const queue = draft.queue ?? { steering: [], followUp: [] }
      draft.queue =
        mode === 'steer'
          ? { ...queue, steering: [...queue.steering, message] }
          : { ...queue, followUp: [...queue.followUp, message] }
      publish(chatId)
      try {
        await api.chat.send({ chatId, message, images, mode })
      } catch (error) {
        // It never reached pi's queue: take it off the strip, give it back.
        const current = drafts.get(chatId)
        if (current?.queue) {
          const drop = (list: string[]): string[] => {
            const at = list.lastIndexOf(message)
            return at === -1 ? list : list.filter((_, i) => i !== at)
          }
          const steering = drop(current.queue.steering)
          const followUp = drop(current.queue.followUp)
          if (steering.length + followUp.length === 0) {
            delete current.queue
          } else {
            current.queue = { steering, followUp }
          }
          current.composerSeed = { text: message, nonce: ++seedCounter }
          publish(chatId)
        }
        throw error
      }
      return
    }
    const display: DisplayMessage = {
      kind: 'user',
      key: `local-${++optimisticCounter}`,
      text: message,
      images: images ?? [],
      ...(draft.piReady === false ? { queued: true } : {}),
      timestamp: Date.now()
    }
    draft.messages.push(display)
    if (draft.title === 'New chat' && message.trim()) {
      draft.title =
        titleFromUserText(message)?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? draft.title
    }
    if (draft.status !== 'streaming') {
      draft.runStartedAt = Date.now()
    }
    draft.status = draft.piReady === false ? 'starting' : 'streaming'
    draft.error = undefined
    publish(chatId)
    // Snapshot the project before pi can touch it, so this prompt's changes
    // can be undone. Skipped while pi is still starting and outside git.
    if (mode === 'prompt' && draft.piReady !== false) {
      const checkpoint = await takeCheckpoint(draft.cwd)
      const current = drafts.get(chatId)
      if (checkpoint && current) {
        const index = current.messages.findIndex((m) => m.key === display.key)
        const row = current.messages[index]
        if (row?.kind === 'user') {
          current.messages[index] = { ...row, checkpoint }
          publish(chatId)
        }
      }
    }
    try {
      await withRevive(chatId, () => api.chat.send({ chatId, message, images, mode }))
    } catch (error) {
      // Nothing reached pi: take the prompt back out of the transcript and
      // hand its text back to the message box instead of losing it.
      const current = drafts.get(chatId)
      if (current) {
        current.messages = current.messages.filter((m) => m.key !== display.key)
        if (current.status === 'streaming') {
          current.status = 'idle'
          delete current.runStartedAt
        }
        current.composerSeed = { text: message, nonce: ++seedCounter }
        publish(chatId)
      }
      throw error
    }
  },

  async abort(chatId) {
    const draft = drafts.get(chatId)
    if (draft) {
      clearCua(draft)
      publish(chatId)
    }
    await api.chat.abort(chatId)
  },

  async runBash(chatId, command) {
    const draft = drafts.get(chatId)
    if (!draft || draft.bashRunning) {
      return
    }
    const key = `local-bash-${++optimisticCounter}`
    draft.messages.push({ kind: 'bash', key, command, output: '', running: true, timestamp: Date.now() })
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
      const result = await withRevive(chatId, () => api.chat.bash(chatId, command))
      settle({ output: result.output, exitCode: result.exitCode, cancelled: result.cancelled })
    } catch (error) {
      settle({ output: errorText(error), exitCode: 1 })
    }
  },

  async abortBash(chatId) {
    await api.chat.abortBash(chatId).catch(() => {})
  },

  async clearQueue(chatId) {
    const draft = drafts.get(chatId)
    if (!draft) {
      return
    }
    const local = draft.queue
    const result = await api.chat.clearQueue(chatId).catch(() => null)
    const current = drafts.get(chatId)
    if (!current) {
      return
    }
    delete current.queue
    const texts = result
      ? [...result.steering, ...result.followUp]
      : [...(local?.steering ?? []), ...(local?.followUp ?? [])]
    if (texts.length > 0) {
      current.composerSeed = { text: texts.join('\n\n'), nonce: ++seedCounter }
    }
    publish(chatId)
  },

  async setModel(chatId, provider, modelId) {
    const result = await withRevive(chatId, () => api.chat.setModel(chatId, provider, modelId))
    const draft = drafts.get(chatId)
    if (draft) {
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
    await withRevive(chatId, () => api.chat.setThinkingLevel(chatId, level))
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
    const previous = draft.cwd
    draft.cwd = cwd
    draft.status = 'starting'
    draft.piReady = false
    draft.startedAt = Date.now()
    draft.error = undefined
    publish(chatId)
    try {
      const result = await api.chat.setCwd(chatId, cwd)
      const current = drafts.get(chatId)
      if (current) {
        Object.assign(current, createChatViewState(), { stats: undefined, uiRequest: undefined })
        applyCatalog(current, result)
        current.cwd = cwd
        current.sessionPath = result.sessionPath ?? undefined
        publish(chatId)
      }
    } catch (error) {
      const current = drafts.get(chatId)
      if (current) {
        current.cwd = previous
        current.status = 'error'
        current.error = errorText(error)
        publish(chatId)
      }
    }
  },

  async refresh(chatId) {
    const draft = drafts.get(chatId)
    if (!draft) {
      return
    }
    const result = await withRevive(chatId, () => api.chat.refresh(chatId, true))
    const current = drafts.get(chatId)
    if (!current) {
      return
    }
    const view = buildChatViewState(result.messages)
    Object.assign(current, view, { stats: undefined, uiRequest: undefined })
    applyCatalog(current, result)
    current.status = result.state.isStreaming ? 'streaming' : 'idle'
    current.hasEarlier = false
    current.transcriptLimit = undefined
    current.title = titleOf(view.messages) ?? current.title
    publish(chatId)
    void refreshStats(chatId)
  },

  async loadEarlier(chatId) {
    const draft = drafts.get(chatId)
    if (!draft?.sessionPath) {
      return
    }
    await applyTranscript(
      chatId,
      draft.sessionPath,
      (draft.transcriptLimit ?? TRANSCRIPT_PAGE) + TRANSCRIPT_PAGE * 2
    )
  },

  async forkAtEntry(chatId, entryId) {
    const result = await withRevive(chatId, () => api.chat.fork(chatId, entryId))
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

  async forkFromUserMessage(chatId, userIndex) {
    const { messages } = await withRevive(chatId, () => api.chat.forkMessages(chatId))
    // The loaded window may start mid-session: count user messages from the end.
    const draft = drafts.get(chatId)
    const loaded = draft?.messages.filter((m) => m.kind === 'user').length ?? 0
    const entry = messages[messages.length - (loaded - userIndex)]
    return entry ? get().forkAtEntry(chatId, entry.entryId) : undefined
  },

  async retryFromUserMessage(chatId, userIndex) {
    const user = drafts.get(chatId)?.messages.filter((m) => m.kind === 'user')[userIndex]
    if (!user || user.kind !== 'user') {
      return
    }
    const text = user.text
    const images = user.images.length ? user.images : undefined
    if ((await get().forkFromUserMessage(chatId, userIndex)) === undefined) {
      return
    }
    const refreshed = drafts.get(chatId)
    if (refreshed?.composerSeed) {
      refreshed.composerSeed = { text: '', nonce: ++seedCounter }
      publish(chatId)
    }
    await get().send(chatId, text, images, 'prompt')
  },

  async reloadChat(chatId) {
    const result = await api.chat.reload(chatId)
    const current = drafts.get(chatId)
    if (current) {
      applyCatalog(current, result)
      current.status = result.state.isStreaming ? 'streaming' : 'idle'
      publish(chatId)
    }
  },

  async cloneChat(chatId) {
    const result = await withRevive(chatId, () => api.chat.clone(chatId))
    if (!result.cancelled) {
      await get().refresh(chatId)
    }
  },

  async compact(chatId, instructions) {
    await withRevive(chatId, () => api.chat.compact(chatId, instructions))
  },

  async rename(chatId, name) {
    await withRevive(chatId, () => api.chat.setSessionName(chatId, name))
    const draft = drafts.get(chatId)
    if (draft) {
      draft.title = name
      publish(chatId)
    }
  },

  seedComposer(chatId, text) {
    const draft = drafts.get(chatId)
    if (draft) {
      draft.composerSeed = { text, nonce: ++seedCounter }
      publish(chatId)
    }
  },

  setVisible(chatId) {
    visibleChatId = chatId
    const draft = chatId ? drafts.get(chatId) : undefined
    if (draft) {
      touchSubscription(draft.chatId)
      if (draft.unread) {
        draft.unread = false
        publish(draft.chatId)
      }
    }
  },

  respondUi(chatId, response) {
    const draft = drafts.get(chatId)
    if (draft) {
      draft.uiRequest = undefined
      publish(chatId)
    }
    void api.chat.respondUi({ chatId, ...response }).catch((e) => toast(errorText(e)))
  }
}))

let wired = false

/** Route the computer's chat broadcasts into the drafts. Once, at launch. */
export function initChatBridge(): void {
  if (wired) {
    return
  }
  wired = true

  onRemote<ChatEventPayload>(EVENTS.chatEvent, ({ chatId, events }) => {
    if (!drafts.has(chatId)) {
      return
    }
    const queue = pendingEvents.get(chatId)
    if (queue) {
      queue.push(...events)
    } else {
      pendingEvents.set(chatId, [...events])
    }
    scheduleFlush()
  })

  onRemote<ChatReadyPayload>(EVENTS.chatReady, (ready) => {
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

  onRemote<ChatStartupHintPayload>(EVENTS.chatHint, ({ chatId, hint }) => {
    const draft = drafts.get(chatId)
    if (draft && !draft.piReady) {
      draft.startupHint = hint
      publish(chatId)
    }
  })

  onRemote<ChatUiRequestPayload>(EVENTS.chatUiRequest, ({ chatId, request }) => {
    const draft = drafts.get(chatId)
    if (draft) {
      draft.uiRequest = request
      publish(chatId)
      // pi is blocked until someone answers: say so wherever the user is.
      if (
        request.method === 'confirm' ||
        request.method === 'select' ||
        request.method === 'input' ||
        request.method === 'editor'
      ) {
        haptic('warning')
        if (visibleChatId !== chatId) {
          toast(`pi needs you: ${request.title ?? draft.title}`, {
            action: { label: 'Open', run: () => openChatHandler?.(chatId) }
          })
        }
      }
    }
  })

  onUnpair(() => {
    drafts.clear()
    pendingEvents.clear()
    openOrder.length = 0
    visibleChatId = null
    useChats.setState({ chats: {} })
  })

  onRemote<{ chatId: string; id: string }>(EVENTS.chatUiResolved, ({ chatId, id }) => {
    const draft = drafts.get(chatId)
    if (draft?.uiRequest?.id === id) {
      draft.uiRequest = undefined
      publish(chatId)
    }
  })

  onRemote<ChatExitPayload>(EVENTS.chatExit, ({ chatId, code, stderrTail }) => {
    const draft = drafts.get(chatId)
    if (!draft) {
      return
    }
    draft.status = 'exited'
    draft.piReady = false
    draft.error = code === 0 ? 'The pi process exited.' : `The pi process exited with code ${code}.`
    draft.stderrTail = stderrTail.length > 0 ? stderrTail : undefined
    publish(chatId)
  })

  onRemote<CuaActivity>(EVENTS.cuaActivity, (activity) => {
    if (activity.phase === 'paused' || activity.phase === 'resumed') {
      for (const draft of drafts.values()) {
        draft.cuaPaused = activity.phase === 'paused'
        publish(draft.chatId)
      }
      return
    }
    const draft = activity.chatId ? drafts.get(activity.chatId) : undefined
    if (!draft) {
      return
    }
    const id = draft.chatId
    draft.cuaActivity = { app: activity.app, summary: activity.summary, phase: activity.phase, at: Date.now() }
    const tail = cuaTails.get(id)
    if (tail) {
      clearTimeout(tail)
      cuaTails.delete(id)
    }
    if (activity.phase === 'start') {
      draft.cuaActive = true
    } else {
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
    publish(id)
  })

  // Back online: events were missed. The chat on screen and the ones that
  // were running catch up now (from the session file and the computer's
  // live list, so no sleeping pi is woken); the rest when they are shown.
  let first = true
  onOnline(() => {
    if (first) {
      first = false
      return
    }
    subscribeChats(openOrder.slice(0, MAX_SUBSCRIBED))
    for (const draft of drafts.values()) {
      if (draft.chatId === visibleChatId || draft.status === 'streaming' || draft.uiRequest) {
        void resync(draft.chatId)
      } else {
        draft.stale = true
      }
    }
  })
}
