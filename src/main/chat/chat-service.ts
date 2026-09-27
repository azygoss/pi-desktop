import { createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  ChatExitPayload,
  ChatOpenInput,
  ChatOpenResult,
  ChatSendInput,
  ChatSessionStats,
  SetModelResult
} from '../../shared/api'
import type {
  AgentMessage,
  Model,
  PiCommandInfo,
  PiEvent,
  PiSessionState,
  PiTreeResult,
  ThinkingLevel
} from '../../shared/pi-types'
import type { PiRpcClient } from '../pi/rpc-client'
import { PiProcessPool, type OpenChatOptions } from '../pi/pool'
import { EventCoalescer } from './event-coalescer'
import { ensureWorkspaceDir, workspaceDir } from '../config/app-paths'
import { updateCatalogCache } from '../config/catalog-cache'
import {
  requireString,
  validateChatId,
  validateCwd,
  validateImages,
  validateMessage,
  validateOutputPath,
  validateSessionPath
} from './validation'

export interface ChatBroadcast {
  (channel: string, payload: unknown): void
}

/**
 * Bridge wiring for the pi browser-tools extension: tokens are issued per
 * chat and revoked when the chat's pi process exits or is closed.
 */
export interface ChatBridgeDeps {
  /** Loopback bridge base URL; empty string disables browser tools. */
  url(): string
  issue(chatId: string): string
  revoke(chatId: string): void
  /** Re-map a token (issued for the warm spare) onto an adopted chat id. */
  adopt?(fromChatId: string, toChatId: string): void
  /** Absolute path to the browser-tools extension; '' when not shipped. */
  extensionPath(): string
}

export const CHAT_CHANNELS = {
  event: 'pi-desktop:chat:event',
  uiRequest: 'pi-desktop:chat:ui-request',
  exit: 'pi-desktop:chat:exit',
  ready: 'pi-desktop:chat:ready'
} as const

interface Gate<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

function createGate<T>(): Gate<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Nobody may be waiting on this (e.g. pi exits before the first send);
  // swallow the rejection so it does not surface as unhandled.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

interface ChatRecord {
  client: PiRpcClient
  chatId: string
  cwd: string
  sessionPath?: string
  streaming: boolean
  spawnedAt: number
  /** Resolves once the process answered its first catalog requests. */
  gate: Gate<void>
  /** Coalesces message_update deltas into batched IPC payloads. */
  coalescer: EventCoalescer
  /** Last time this chat's view was shown (idle eviction bookkeeping). */
  lastViewedAt: number
  /** True while this chat's view is the visible one (exempt from eviction). */
  focused: boolean
  /** A pending extension UI request keeps the process alive. */
  pendingUi: boolean
}

/** Chat id used for the warm spare process until a draft adopts it. */
const SPARE_CHAT_ID = '__spare__'

const EXIT_STDERR_LINES = 20

/** Idle pi processes (not streaming, not visible, no pending UI) to keep. */
const MAX_IDLE_PROCESSES = 4
/** Idle chats not viewed for this long are stopped (revived on demand). */
const IDLE_EVICT_MS = 10 * 60 * 1000
const EVICT_SWEEP_MS = 60 * 1000

/** Eviction policy overrides (tests). */
export interface EvictionOptions {
  maxIdleProcesses?: number
  idleEvictMs?: number
  sweepIntervalMs?: number
}

/** Read just the session header line (first line) of a session file. */
async function readSessionCwd(filePath: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const stream = createReadStream(filePath, { start: 0, end: 64 * 1024 })
    let buffer = ''
    let done = false
    const finish = (cwd: string | null) => {
      if (!done) {
        done = true
        stream.destroy()
        resolvePromise(cwd)
      }
    }
    stream.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const idx = buffer.indexOf('\n')
      if (idx === -1) {
        return
      }
      try {
        const header = JSON.parse(buffer.slice(0, idx)) as Record<string, unknown>
        finish(typeof header['cwd'] === 'string' ? header['cwd'] : null)
      } catch {
        finish(null)
      }
    })
    stream.on('end', () => finish(null))
    stream.on('error', () => finish(null))
  })
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Owns the mapping between renderer chat ids and `pi --mode rpc` processes.
 * Pi only writes the session file when the first message lands, so a freshly
 * spawned draft chat does not litter the sessions directory.
 */
export class ChatService {
  private readonly chats = new Map<string, ChatRecord>()
  /**
   * chatId → record gate for `open()` calls still spawning. Lets a send that
   * arrives before the record exists queue transparently instead of failing.
   */
  private readonly pendingOpens = new Map<string, Gate<ChatRecord>>()
  /**
   * One pre-spawned pi for the "Without project" workspace. Pi's startup can
   * take seconds (eager extensions/MCP servers), so the spare is spawned
   * shortly after launch and adopted by the next project-less draft.
   */
  private spare: { id: string; client: PiRpcClient; warm: Promise<void> } | null = null
  /**
   * Chats whose idle process was evicted: enough context to respawn on the
   * same cwd/session the next time the renderer talks to them.
   */
  private readonly evicted = new Map<string, { cwd: string; sessionPath?: string }>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private readonly eviction: Required<EvictionOptions>

  constructor(
    private readonly pool: PiProcessPool,
    private readonly broadcast: ChatBroadcast,
    private readonly bridge?: ChatBridgeDeps,
    eviction: EvictionOptions = {}
  ) {
    this.eviction = {
      maxIdleProcesses: eviction.maxIdleProcesses ?? MAX_IDLE_PROCESSES,
      idleEvictMs: eviction.idleEvictMs ?? IDLE_EVICT_MS,
      sweepIntervalMs: eviction.sweepIntervalMs ?? EVICT_SWEEP_MS
    }
    this.sweepTimer = setInterval(
      () => void this.sweepEvictions(),
      this.eviction.sweepIntervalMs
    )
    this.sweepTimer.unref?.()
  }

  /** Extra spawn args/env for the browser-tools extension + bridge token. */
  private bridgeExtras(chatId: string): Pick<OpenChatOptions, 'extraArgs' | 'extraEnv'> {
    const extraArgs: string[] = []
    const extraEnv: Record<string, string> = {}
    if (this.bridge && this.bridge.url()) {
      const extensionPath = this.bridge.extensionPath()
      if (extensionPath) {
        extraArgs.push('--extension', extensionPath)
      }
      extraEnv['PI_DESKTOP_BRIDGE_URL'] = this.bridge.url()
      extraEnv['PI_DESKTOP_BRIDGE_TOKEN'] = this.bridge.issue(chatId)
    }
    return {
      extraArgs: extraArgs.length ? extraArgs : undefined,
      extraEnv: Object.keys(extraEnv).length ? extraEnv : undefined
    }
  }

  /**
   * Keep one pi process warming for the next project-less chat. Called a few
   * seconds after launch and again each time the spare is adopted.
   */
  async warmSpare(): Promise<void> {
    if (this.spare) {
      return
    }
    try {
      await ensureWorkspaceDir()
      const client = await this.pool.open(SPARE_CHAT_ID, {
        cwd: workspaceDir(),
        ...this.bridgeExtras(SPARE_CHAT_ID)
      })
      // Warming: pi only becomes responsive once startup work (eager MCP
      // servers, extension init) is done; the first request absorbs that.
      const warm = client
        .request({ type: 'get_state' })
        .then(() => {})
        .catch(() => {})
      this.spare = { id: SPARE_CHAT_ID, client, warm }
      client.on('exit', () => {
        if (this.spare?.client === client) {
          this.spare = null
        }
        this.bridge?.revoke(SPARE_CHAT_ID)
      })
    } catch {
      this.spare = null // no runtime yet — drafts will spawn normally
    }
  }

  async open(input: ChatOpenInput): Promise<ChatOpenResult> {
    const chatId = validateChatId(input.chatId)
    const sessionPath =
      input.sessionPath !== undefined ? validateSessionPath(input.sessionPath) : undefined

    const existing = this.chats.get(chatId)
    // Concurrent open() for the same chat (e.g. an ensureChat retry while
    // the first open is in flight) piggybacks on it instead of spawning a
    // second pi process.
    const pending = this.pendingOpens.get(chatId)
    if (pending) {
      const record = await pending.promise
      return this.fetchCatalog(record.client, chatId, record.cwd, record.sessionPath)
    }
    // A send arriving before the record exists should queue, not fail —
    // register the gate before any async work so send() can see it.
    const openGate = createGate<ChatRecord>()
    this.pendingOpens.set(chatId, openGate)
    try {
      let cwd: string
      if (sessionPath !== undefined) {
        // Reopening a past session: prefer its recorded cwd when it still exists.
        const sessionCwd = await readSessionCwd(sessionPath)
        cwd = sessionCwd !== null && (await dirExists(sessionCwd)) ? sessionCwd : homedir()
      } else {
        // The scratch dir for project-less chats is created on demand.
        if (input.cwd === workspaceDir()) {
          await ensureWorkspaceDir()
        }
        cwd = await validateCwd(input.cwd)
      }

      let client: PiRpcClient | undefined
      let spareWarm: Promise<void> | undefined
      // Project-less drafts adopt the warm spare when one is waiting.
      if (!existing && sessionPath === undefined && cwd === workspaceDir() && this.spare) {
        const adopted = this.pool.adopt(this.spare.id, chatId)
        if (adopted) {
          this.bridge?.adopt?.(this.spare.id, chatId)
          spareWarm = this.spare.warm
          client = adopted
          this.spare = null
          void this.warmSpare() // spawn the replacement in the background
        }
      }
      if (!client) {
        client = await this.pool.open(chatId, { cwd, sessionPath, ...this.bridgeExtras(chatId) })
        if (this.pendingOpens.get(chatId) !== openGate) {
          // close() ran (or a newer open superseded us) while pi was
          // spawning — drop the process instead of resurrecting the chat.
          void client.stop()
          throw new Error('Chat closed')
        }
      }

      let record = this.chats.get(chatId)
      if (!record || record.client !== client) {
        record = {
          client,
          chatId,
          cwd,
          sessionPath,
          streaming: false,
          spawnedAt: Date.now(),
          gate: createGate<void>(),
          coalescer: new EventCoalescer((events) =>
            this.broadcast(CHAT_CHANNELS.event, { chatId, events })
          ),
          lastViewedAt: Date.now(),
          focused: false,
          pendingUi: false
        }
        this.chats.set(chatId, record)
        this.attachClient(record)
      }
      openGate.resolve(record)

      if (spareWarm) {
        await spareWarm
      }
      const result = await this.fetchCatalog(record.client, chatId, cwd, sessionPath)
      const startupMs = Date.now() - record.spawnedAt
      if (result.sessionPath) {
        // pi allocates the session file lazily; remember it so an evicted
        // chat can be revived onto the same session later.
        record.sessionPath = result.sessionPath
      }
      record.gate.resolve()
      updateCatalogCache({
        models: result.models,
        commands: result.commands,
        thinkingLevels: result.thinkingLevels,
        model: result.state.model ?? null,
        thinkingLevel: result.state.thinkingLevel ?? null,
        lastStartupMs: startupMs
      })
      this.broadcast(CHAT_CHANNELS.ready, {
        chatId,
        state: result.state,
        models: result.models,
        thinkingLevels: result.thinkingLevels,
        commands: result.commands,
        sessionPath: result.sessionPath,
        startupMs
      })
      return result
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error))
      openGate.reject(cause)
      this.chats.get(chatId)?.gate.reject(cause)
      throw error
    } finally {
      // A newer open() may have replaced the gate (ensureChat retry) — only
      // remove the entry that is still ours.
      if (this.pendingOpens.get(chatId) === openGate) {
        this.pendingOpens.delete(chatId)
      }
    }
  }

  /** Re-fetch state/messages/models for an already-open chat. */
  async refresh(input: { chatId: string }): Promise<ChatOpenResult> {
    const record = await this.requireReady(validateChatId(input.chatId))
    return this.fetchCatalog(record.client, record.chatId, record.cwd, record.sessionPath)
  }

  private async fetchCatalog(
    client: PiRpcClient,
    chatId: string,
    cwd: string,
    sessionPath?: string
  ): Promise<ChatOpenResult> {
    const [state, messages, models, thinkingLevels, commands] = await Promise.all([
      client.request<PiSessionState>({ type: 'get_state' }),
      client.request<{ messages: AgentMessage[] }>({ type: 'get_messages' }),
      client.request<{ models: Model[] }>({ type: 'get_available_models' }),
      client.request<{ levels: ThinkingLevel[] }>({ type: 'get_available_thinking_levels' }),
      client.request<{ commands: PiCommandInfo[] }>({ type: 'get_commands' })
    ])

    return {
      chatId,
      cwd,
      state: state ?? ({} as PiSessionState),
      messages: messages?.messages ?? [],
      models: models?.models ?? [],
      thinkingLevels: thinkingLevels?.levels ?? ['off'],
      commands: commands?.commands ?? [],
      sessionPath: state?.sessionFile ?? sessionPath
    }
  }

  async send(input: ChatSendInput): Promise<void> {
    const chatId = validateChatId(input.chatId)
    const message = validateMessage(input.message)
    const images = validateImages(input.images)
    // Queued send: while pi is still starting the request waits here; the
    // renderer already shows the user message with a queued indicator.
    const record = await this.requireReady(chatId)

    const mode = input.mode
    if (mode === 'steer') {
      await record.client.request({ type: 'steer', message, ...(images ? { images } : {}) })
    } else if (mode === 'followUp') {
      await record.client.request({ type: 'follow_up', message, ...(images ? { images } : {}) })
    } else if (mode === 'prompt') {
      await record.client.request({
        type: 'prompt',
        message,
        ...(images ? { images } : {}),
        ...(record.streaming ? { streamingBehavior: 'steer' as const } : {})
      })
    } else {
      throw new Error(`Invalid send mode: ${String(mode)}`)
    }
  }

  async abort(input: { chatId: string }): Promise<void> {
    const record = await this.requireReady(validateChatId(input.chatId))
    await record.client.request({ type: 'abort' }, { timeoutMs: 15000 })
  }

  async setModel(input: {
    chatId: string
    provider: string
    modelId: string
  }): Promise<SetModelResult> {
    const record = await this.requireReady(validateChatId(input.chatId))
    const provider = requireString(input.provider, 'provider', 128)
    const modelId = requireString(input.modelId, 'modelId', 256)
    await record.client.request({ type: 'set_model', provider, modelId })
    // Thinking levels are per-model and pi may clamp the current level, so
    // fetch the post-switch levels and state in one round trip.
    const [levelsResult, state] = await Promise.all([
      record.client.request<{ levels: ThinkingLevel[] }>({
        type: 'get_available_thinking_levels'
      }),
      record.client.request<PiSessionState>({ type: 'get_state' })
    ])
    return {
      model: state?.model ?? null,
      thinkingLevel: state?.thinkingLevel ?? null,
      thinkingLevels: levelsResult?.levels ?? ['off']
    }
  }

  async setThinkingLevel(input: { chatId: string; level: ThinkingLevel }): Promise<void> {
    const record = await this.requireReady(validateChatId(input.chatId))
    const level = requireString(input.level, 'level', 32) as ThinkingLevel
    await record.client.request({ type: 'set_thinking_level', level })
  }

  async getStats(input: { chatId: string }): Promise<ChatSessionStats | undefined> {
    const record = await this.requireReady(validateChatId(input.chatId))
    return record.client.request<ChatSessionStats>({ type: 'get_session_stats' })
  }

  async compact(input: { chatId: string; customInstructions?: string }): Promise<void> {
    const record = await this.requireReady(validateChatId(input.chatId))
    const customInstructions =
      input.customInstructions === undefined
        ? undefined
        : requireString(input.customInstructions, 'customInstructions', 4096)
    await record.client.request({
      type: 'compact',
      ...(customInstructions ? { customInstructions } : {})
    })
  }

  async setSessionName(input: { chatId: string; name: string }): Promise<void> {
    const record = await this.requireReady(validateChatId(input.chatId))
    const name = requireString(input.name, 'name', 200)
    await record.client.request({ type: 'set_session_name', name })
  }

  async exportHtml(input: { chatId: string; outputPath: string }): Promise<{ path?: string }> {
    const record = await this.requireReady(validateChatId(input.chatId))
    const outputPath = validateOutputPath(input.outputPath)
    const result = await record.client.request<{ path?: string }>({
      type: 'export_html',
      outputPath
    })
    return result ?? {}
  }

  async setCwd(input: { chatId: string; cwd: string }): Promise<ChatOpenResult> {
    const chatId = validateChatId(input.chatId)
    if (input.cwd === workspaceDir()) {
      await ensureWorkspaceDir()
    }
    const cwd = await validateCwd(input.cwd)
    await this.close({ chatId })
    return this.open({ chatId, cwd })
  }

  /**
   * Restart the chat's pi process on the same session — reloads extensions,
   * skills, prompt templates and keybindings (/reload).
   */
  async reload(input: { chatId: string }): Promise<ChatOpenResult> {
    const record = await this.requireReady(validateChatId(input.chatId))
    const { chatId, cwd, sessionPath } = record
    await this.close({ chatId })
    return this.open({ chatId, cwd, sessionPath })
  }

  /** Session entry tree for the /tree modal. */
  async getTree(input: { chatId: string }): Promise<PiTreeResult> {
    const record = await this.requireReady(validateChatId(input.chatId))
    return (
      (await record.client.request<PiTreeResult>({ type: 'get_tree' })) ?? {
        tree: [],
        leafId: null
      }
    )
  }

  /** Last assistant text for /copy. */
  async getLastAssistantText(input: { chatId: string }): Promise<{ text: string | null }> {
    const record = await this.requireReady(validateChatId(input.chatId))
    const result = await record.client.request<{ text?: string | null }>({
      type: 'get_last_assistant_text'
    })
    return { text: result?.text ?? null }
  }

  async getForkMessages(input: {
    chatId: string
  }): Promise<{ messages: { entryId: string; text: string }[] }> {
    const record = await this.requireReady(validateChatId(input.chatId))
    const result = await record.client.request<{
      messages?: { entryId: string; text: string }[]
    }>({ type: 'get_fork_messages' })
    return { messages: result?.messages ?? [] }
  }

  async fork(input: {
    chatId: string
    entryId: string
  }): Promise<{ text?: string; cancelled?: boolean }> {
    const record = await this.requireReady(validateChatId(input.chatId))
    const entryId = requireString(input.entryId, 'entryId', 256)
    return (
      (await record.client.request<{ text?: string; cancelled?: boolean }>({
        type: 'fork',
        entryId
      })) ?? {}
    )
  }

  async clone(input: { chatId: string }): Promise<{ cancelled?: boolean }> {
    const record = await this.requireReady(validateChatId(input.chatId))
    return (
      (await record.client.request<{ cancelled?: boolean }>({ type: 'clone' })) ?? {}
    )
  }

  /**
   * Rename a session that may not have an open chat: reuses the open chat's
   * process when one exists, otherwise spawns a short-lived `pi --session`
   * process just for the rename. Session files are never written directly.
   */
  async renameSession(input: { sessionPath: string; name: string }): Promise<void> {
    const sessionPath = validateSessionPath(input.sessionPath)
    const name = requireString(input.name, 'name', 200)
    const record = this.recordForSession(sessionPath)
    if (record) {
      await record.client.request({ type: 'set_session_name', name })
      return
    }
    await this.withTemporaryClient(sessionPath, async (client) => {
      await client.request({ type: 'set_session_name', name })
    })
  }

  /** Export a session to HTML; uses the open chat's process when available. */
  async exportSession(input: {
    sessionPath: string
    outputPath: string
  }): Promise<{ path?: string }> {
    const sessionPath = validateSessionPath(input.sessionPath)
    const outputPath = validateOutputPath(input.outputPath)
    const record = this.recordForSession(sessionPath)
    if (record) {
      return (
        (await record.client.request<{ path?: string }>({
          type: 'export_html',
          outputPath
        })) ?? {}
      )
    }
    let result: { path?: string } = {}
    await this.withTemporaryClient(sessionPath, async (client) => {
      result =
        (await client.request<{ path?: string }>({
          type: 'export_html',
          outputPath
        })) ?? {}
    })
    return result
  }

  /**
   * Close the open chat that uses this session file, if any. Returns true
   * when a chat was closed (used before trashing a session file).
   */
  async closeChatForSession(sessionPath: string): Promise<boolean> {
    const record = this.recordForSession(sessionPath)
    if (!record) {
      return false
    }
    await this.close({ chatId: record.chatId })
    return true
  }

  /** The chatId currently viewing a session path, if open. */
  chatIdForSession(sessionPath: string): string | undefined {
    return this.recordForSession(sessionPath)?.chatId
  }

  private recordForSession(sessionPath: string): ChatRecord | undefined {
    for (const record of this.chats.values()) {
      if (record.sessionPath === sessionPath) {
        return record
      }
    }
    return undefined
  }

  private async withTemporaryClient(
    sessionPath: string,
    run: (client: PiRpcClient) => Promise<void>
  ): Promise<void> {
    const tempId = `tmp-${Math.random().toString(36).slice(2, 12)}`
    const sessionCwd = await readSessionCwd(sessionPath)
    const cwd = sessionCwd !== null && (await dirExists(sessionCwd)) ? sessionCwd : homedir()
    const client = await this.pool.open(tempId, { cwd, sessionPath })
    try {
      await run(client)
    } finally {
      await this.pool.close(tempId)
    }
  }

  async respondUi(input: { chatId: string } & Record<string, unknown>): Promise<void> {
    const record = await this.requireReady(validateChatId(input.chatId))
    const id = requireString(input.id, 'ui request id', 128)
    record.pendingUi = false
    record.client.respondUi({
      id,
      ...(typeof input.value === 'string' ? { value: input.value } : {}),
      ...(typeof input.confirmed === 'boolean' ? { confirmed: input.confirmed } : {}),
      ...(input.cancelled === true ? { cancelled: true } : {})
    })
  }

  async close(input: { chatId: string }): Promise<void> {
    const chatId = validateChatId(input.chatId)
    const record = this.chats.get(chatId)
    this.chats.delete(chatId)
    record?.gate.reject(new Error('Chat closed'))
    this.pendingOpens.get(chatId)?.reject(new Error('Chat closed'))
    this.pendingOpens.delete(chatId)
    this.bridge?.revoke(chatId)
    await this.pool.close(chatId)
  }

  async closeAll(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    for (const record of this.chats.values()) {
      record.gate.reject(new Error('Chat closed'))
      record.coalescer.dispose()
    }
    for (const gate of this.pendingOpens.values()) {
      gate.reject(new Error('Chat closed'))
    }
    this.chats.clear()
    this.pendingOpens.clear()
    this.evicted.clear()
    this.spare = null
    await this.pool.closeAll()
  }

  /**
   * Record lookup that tolerates the window between `open()` starting and
   * the record existing, then waits until pi is answering. This is what
   * makes sends and model changes issued during startup queue
   * transparently instead of failing.
   */
  private async requireReady(chatId: string): Promise<ChatRecord> {
    let record = this.chats.get(chatId)
    if (!record) {
      const gate = this.pendingOpens.get(chatId)
      if (gate) {
        record = await gate.promise
      }
    }
    if (!record) {
      const evicted = this.evicted.get(chatId)
      if (evicted) {
        // Transparent revive: respawn pi on the same cwd/session; the send
        // that triggered this resumes through the normal queued path.
        this.evicted.delete(chatId)
        await this.open({ chatId, cwd: evicted.cwd, sessionPath: evicted.sessionPath })
        record = this.chats.get(chatId)
      }
    }
    if (!record) {
      throw new Error(`No running pi process for chat ${chatId}`)
    }
    await record.gate.promise
    if (!record.client.isRunning) {
      throw new Error(`No running pi process for chat ${chatId}`)
    }
    return record
  }

  /** Note that a chat's view is currently shown (idle eviction bookkeeping). */
  markFocused(chatId: string): void {
    for (const record of this.chats.values()) {
      record.focused = record.chatId === chatId
    }
    const record = this.chats.get(chatId)
    if (record) {
      record.lastViewedAt = Date.now()
    }
  }

  /**
   * Stop pi processes that have been idle too long, and cap the number of
   * idle processes. A chat counts as live-idle only when it is not
   * streaming, not the visible chat and has no pending UI request. The
   * transcript stays in the renderer; the next send revives it via the
   * evicted map. The warm spare is tracked separately and never counted.
   */
  async sweepEvictions(): Promise<void> {
    const now = Date.now()
    const idle = [...this.chats.values()].filter(
      (record) => !record.streaming && !record.focused && !record.pendingUi
    )
    const expired = idle.filter(
      (record) => now - record.lastViewedAt > this.eviction.idleEvictMs
    )
    const alive = idle.filter((record) => !expired.includes(record))
    alive.sort((a, b) => b.lastViewedAt - a.lastViewedAt)
    const overCap = alive.slice(this.eviction.maxIdleProcesses)
    for (const record of [...expired, ...overCap]) {
      await this.evict(record)
    }
  }

  /** Stop an idle chat's process but keep enough context to revive it. */
  private async evict(record: ChatRecord): Promise<void> {
    this.chats.delete(record.chatId)
    record.coalescer.dispose()
    // Grab the session file pi allocated since open() (undefined until the
    // first prompt) so revival resumes the same session.
    let sessionPath = record.sessionPath
    if (!sessionPath && record.client.isRunning) {
      const state = await record.client
        .request<{ sessionFile?: string }>({ type: 'get_state' }, { timeoutMs: 2000 })
        .catch(() => undefined)
      sessionPath = state?.sessionFile
    }
    this.evicted.set(record.chatId, {
      cwd: record.cwd,
      ...(sessionPath ? { sessionPath } : {})
    })
    record.gate.reject(new Error('Chat evicted'))
    this.bridge?.revoke(record.chatId)
    await this.pool.close(record.chatId)
  }

  /** Test/observability hook: is a live process attached to this chat? */
  hasProcess(chatId: string): boolean {
    return this.chats.has(chatId)
  }

  /** Test/observability hook: was this chat's process evicted? */
  isEvicted(chatId: string): boolean {
    return this.evicted.has(chatId)
  }

  private attachClient(record: ChatRecord): void {
    const { client, chatId } = record
    client.on('event', (event: PiEvent) => {
      if (event.type === 'agent_start') {
        record.streaming = true
      } else if (event.type === 'agent_settled') {
        record.streaming = false
      }
      record.coalescer.push(event)
    })
    client.on('ui-request', (request) => {
      record.pendingUi = true
      this.broadcast(CHAT_CHANNELS.uiRequest, { chatId, request })
    })
    client.on('exit', ({ code, signal }) => {
      const current = this.chats.get(chatId)
      this.chats.delete(chatId)
      record.coalescer.dispose()
      record.gate.reject(
        new Error(`pi process exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
      )
      this.bridge?.revoke(chatId)
      if (current !== record) {
        // Silent teardown: evicted or explicitly closed chats keep their
        // transcript in the renderer; nothing to notify.
        return
      }
      const payload: ChatExitPayload = {
        chatId,
        code,
        signal,
        stderrTail: [...client.stderrTail].slice(-EXIT_STDERR_LINES)
      }
      this.broadcast(CHAT_CHANNELS.exit, payload)
    })
  }
}

export function basenameOrHome(cwd: string): string {
  return cwd === homedir() ? '~' : basename(cwd)
}
