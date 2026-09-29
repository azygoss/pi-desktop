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
  /** Whether to expose computer_* tools to this chat's pi process. */
  computerToolsEnabled?(): boolean
}

export const CHAT_CHANNELS = {
  event: 'pi-desktop:chat:event',
  uiRequest: 'pi-desktop:chat:ui-request',
  exit: 'pi-desktop:chat:exit',
  ready: 'pi-desktop:chat:ready',
  /** A startup blocker detected on pi's stderr (e.g. a retrying MCP server). */
  hint: 'pi-desktop:chat:hint'
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
  /** True once the first catalog round trip finished (open settled). */
  ready: boolean
  /** True once a prompt/steer/follow-up was issued — parked spares stay clean. */
  prompted: boolean
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
  /** attachClient listener refs, removed when the process is parked as a spare. */
  listeners: {
    event: (event: PiEvent) => void
    uiRequest: (request: unknown) => void
    exit: (payload: { code: number | null; signal: string | null }) => void
    stderr: (line: string) => void
  }
}

/**
 * A pre-spawned pi waiting to be adopted by the next chat for `cwd`. Spares
 * absorb pi's startup time (eager extensions/MCP servers can take seconds):
 * the workspace spare warms right after launch, project spares warm on hover
 * or are parked from chats that closed before their first prompt.
 */
interface WarmSpare {
  id: string
  client: PiRpcClient
  warm: Promise<void>
  at: number
  /** The workspace spare regenerates after adoption and never expires. */
  pinned: boolean
}

/** Chat id used for the pinned workspace spare until a draft adopts it. */
const SPARE_CHAT_ID = '__spare__'

const EXIT_STDERR_LINES = 20

/** Idle pi processes (not streaming, not visible, no pending UI) to keep. */
const MAX_IDLE_PROCESSES = 4
/** Idle chats not viewed for this long are stopped (revived on demand). */
const IDLE_EVICT_MS = 10 * 60 * 1000
const EVICT_SWEEP_MS = 60 * 1000
/** Unadopted non-pinned spares kept warm; extra ones are stopped. */
const MAX_WARM_SPARES = 2
/** Project spares parked/warmed this long ago are stopped as unused. */
const SPARE_TTL_MS = 5 * 60 * 1000
/** A spare that cannot load a session this fast is replaced by a spawn. */
const SWITCH_SESSION_TIMEOUT_MS = 15_000

/**
 * Translate a pi stderr line into a user-facing startup hint. Covers the
 * pi-mcp extension's retry/failure messages, the common slow-boot cause.
 */
export function startupHintFromStderr(line: string): string | undefined {
  const retry = /Retrying "([^"]+)"/.exec(line)
  if (retry) {
    return `waiting on MCP server “${retry[1]}”`
  }
  const failed = /Server "([^"]+)" failed/.exec(line)
  if (failed) {
    return `MCP server “${failed[1]}” failed to start`
  }
  return undefined
}

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
   * Pre-spawned pi processes waiting to be adopted, keyed by cwd. The pinned
   * "Without project" spare warms after launch; project spares are added by
   * warmCwd() (hover intent) or parked from chats closed before their first
   * prompt. Non-pinned spares are capped and expire after SPARE_TTL_MS.
   */
  private readonly spares = new Map<string, WarmSpare>()
  private readonly spareSpawning = new Set<string>()
  private warmSeq = 0
  /** Bumped by resetSpares(); in-flight spawns from before the bump stop. */
  private spareGeneration = 0
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
      // The extension registers computer_* tools only when this env flag is
      // present, so a disabled setting or missing helper hides them entirely.
      if (this.bridge.computerToolsEnabled?.() === true) {
        extraEnv['PI_DESKTOP_COMPUTER_USE'] = '1'
      }
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
    await this.ensureSpare(workspaceDir(), true)
  }

  /**
   * Warm a spare pi for a project cwd (hover intent from the project list).
   * Best-effort: unknown dirs and missing runtimes are ignored silently.
   */
  async warmCwd(input: { cwd: string }): Promise<void> {
    const cwd = await validateCwd(input.cwd)
    if (cwd === workspaceDir()) {
      await ensureWorkspaceDir()
      await this.ensureSpare(cwd, true)
      return
    }
    await this.ensureSpare(cwd, false)
  }

  private ensureSpare(cwd: string, pinned: boolean): Promise<void> {
    const existing = this.spares.get(cwd)
    if (existing) {
      existing.at = Date.now() // hover/interest refreshes the TTL
      return Promise.resolve()
    }
    if (this.spareSpawning.has(cwd)) {
      return Promise.resolve()
    }
    this.spareSpawning.add(cwd)
    const generation = this.spareGeneration
    return (async () => {
      try {
        if (cwd === workspaceDir()) {
          await ensureWorkspaceDir()
        }
        const id = pinned ? SPARE_CHAT_ID : `__warm__${++this.warmSeq}`
        const client = await this.pool.open(id, { cwd, ...this.bridgeExtras(id) })
        if (generation !== this.spareGeneration || this.spares.has(cwd)) {
          void client.stop() // stale spawn env or a parked spare arrived first
          return
        }
        // Warming: pi only becomes responsive once startup work (eager MCP
        // servers, extension init) is done; the first request absorbs that.
        const warm = client
          .request({ type: 'get_state' })
          .then(() => {})
          .catch(() => {})
        this.spares.set(cwd, { id, client, warm, at: Date.now(), pinned })
        client.on('exit', () => {
          if (this.spares.get(cwd)?.client === client) {
            this.spares.delete(cwd)
          }
          this.bridge?.revoke(id)
        })
        this.capSpares()
      } catch {
        // No runtime (or dir) — opens will spawn normally.
      } finally {
        this.spareSpawning.delete(cwd)
      }
    })()
  }

  /**
   * Spawn-time env changed (e.g. computerUse.enabled flips
   * PI_DESKTOP_COMPUTER_USE) — drop every warm spare so the next chat adopts
   * a process spawned with current flags, then re-warm the workspace spare.
   */
  async resetSpares(): Promise<void> {
    this.spareGeneration++
    await Promise.all([...this.spares.keys()].map((cwd) => this.removeSpare(cwd)))
    void this.warmSpare()
  }

  /** Remove a warm spare entirely (stop its process and revoke its token). */
  private async removeSpare(cwd: string): Promise<void> {
    const spare = this.spares.get(cwd)
    if (!spare) {
      return
    }
    this.spares.delete(cwd)
    this.bridge?.revoke(spare.id)
    await this.pool.close(spare.id)
  }

  /** Stop the oldest non-pinned spares beyond MAX_WARM_SPARES. */
  private capSpares(): void {
    const loose = [...this.spares.entries()]
      .filter(([, spare]) => !spare.pinned)
      .sort((a, b) => a[1].at - b[1].at)
    for (const [cwd] of loose.slice(0, Math.max(0, loose.length - MAX_WARM_SPARES))) {
      void this.removeSpare(cwd)
    }
  }

  /**
   * Turn an unneeded chat process into a warm spare for its cwd instead of
   * killing it — switching a draft's project or closing an untouched draft
   * recycles the already-warming process. Only clean processes qualify: a
   * prompted or session-bound pi carries state that must not leak into the
   * next chat.
   */
  private parkRecord(record: ChatRecord): boolean {
    if (
      !record.ready ||
      record.prompted ||
      record.streaming ||
      record.sessionPath !== undefined ||
      !record.client.isRunning ||
      record.cwd === workspaceDir()
    ) {
      return false
    }
    const id = `__warm__${++this.warmSeq}`
    if (!this.pool.adopt(record.chatId, id)) {
      return false
    }
    // Detach the old chat's listeners; the adopt path re-attaches fresh ones.
    record.coalescer.dispose()
    record.client.off('event', record.listeners.event)
    record.client.off('ui-request', record.listeners.uiRequest)
    record.client.off('exit', record.listeners.exit)
    record.client.off('stderr', record.listeners.stderr)
    this.bridge?.adopt?.(record.chatId, id)
    const replaced = this.spares.get(record.cwd)
    if (replaced) {
      this.spares.delete(record.cwd)
      this.bridge?.revoke(replaced.id)
      void this.pool.close(replaced.id)
    }
    const { client, cwd } = record
    client.on('exit', () => {
      if (this.spares.get(cwd)?.client === client) {
        this.spares.delete(cwd)
      }
      this.bridge?.revoke(id)
    })
    this.spares.set(cwd, {
      id,
      client,
      warm: Promise.resolve(),
      at: Date.now(),
      pinned: false
    })
    this.capSpares()
    return true
  }

  /**
   * Take the warm spare for `cwd` (if one is running) and re-key it to
   * `chatId`. A pinned spare is replaced in the background.
   */
  private adoptSpare(cwd: string, chatId: string): WarmSpare | undefined {
    const spare = this.spares.get(cwd)
    if (!spare || !spare.client.isRunning || !this.pool.adopt(spare.id, chatId)) {
      return undefined
    }
    this.bridge?.adopt?.(spare.id, chatId)
    this.spares.delete(cwd)
    if (spare.pinned) {
      void this.warmSpare() // spawn the replacement in the background
    }
    // Retries that already fired while the spare warmed still explain a
    // slow startup — surface the latest one to the new chat.
    for (let i = spare.client.stderrTail.length - 1; i >= 0; i--) {
      const hint = startupHintFromStderr(spare.client.stderrTail[i]!)
      if (hint) {
        this.broadcast(CHAT_CHANNELS.hint, { chatId, hint })
        break
      }
    }
    return spare
  }

  /**
   * Load a past session into an adopted spare. On failure (or an extension
   * cancelling the switch) the spare is stopped and false is returned, so
   * the caller spawns `pi --session` the usual way.
   */
  private async switchAdoptedSpare(
    spare: WarmSpare,
    chatId: string,
    sessionPath: string
  ): Promise<boolean> {
    try {
      await spare.warm
      const result = await spare.client.request<{ cancelled?: boolean }>(
        { type: 'switch_session', sessionPath },
        { timeoutMs: SWITCH_SESSION_TIMEOUT_MS }
      )
      if (result?.cancelled !== true) {
        return true
      }
    } catch {
      // fall through to a fresh spawn
    }
    this.bridge?.revoke(chatId)
    await this.pool.close(chatId)
    return false
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
      // A warm spare for this cwd skips pi's startup (extensions, MCP
      // servers) and saves a process: drafts adopt it as is, past sessions
      // load into it through switch_session.
      if (!existing) {
        const spare = this.adoptSpare(cwd, chatId)
        if (spare && sessionPath === undefined) {
          client = spare.client
          spareWarm = spare.warm
        } else if (spare && sessionPath !== undefined) {
          if (await this.switchAdoptedSpare(spare, chatId, sessionPath)) {
            client = spare.client
          }
        }
      }
      if (!client) {
        client = await this.pool.open(chatId, { cwd, sessionPath, ...this.bridgeExtras(chatId) })
      }
      if (this.pendingOpens.get(chatId) !== openGate) {
        // close() ran (or a newer open superseded us) while pi was
        // spawning — drop the process instead of resurrecting the chat.
        void client.stop()
        throw new Error('Chat closed')
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
          ready: false,
          prompted: false,
          gate: createGate<void>(),
          coalescer: new EventCoalescer((events) =>
            this.broadcast(CHAT_CHANNELS.event, { chatId, events })
          ),
          lastViewedAt: Date.now(),
          focused: false,
          pendingUi: false,
          listeners: {
            event: () => {},
            uiRequest: () => {},
            exit: () => {},
            stderr: () => {}
          }
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
      record.ready = true
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
    record.prompted = true

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
    // A clean, unprompted process becomes a warm spare for its cwd instead of
    // dying — the next chat for that project adopts it instantly.
    if (record && this.parkRecord(record)) {
      return
    }
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
    this.spares.clear()
    this.spareSpawning.clear()
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
    // Expire unadopted project spares — the pinned workspace spare stays.
    for (const [cwd, spare] of this.spares) {
      if (!spare.pinned && now - spare.at > SPARE_TTL_MS) {
        await this.removeSpare(cwd)
      }
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

  /** Test/observability hook: is a warm spare waiting for this cwd? */
  hasWarmSpare(cwd: string): boolean {
    return this.spares.get(cwd)?.client.isRunning === true
  }

  /** Test/observability hook: was this chat's process evicted? */
  isEvicted(chatId: string): boolean {
    return this.evicted.has(chatId)
  }

  private attachClient(record: ChatRecord): void {
    const { client, chatId } = record
    const onEvent = (event: PiEvent) => {
      if (event.type === 'agent_start') {
        record.streaming = true
      } else if (event.type === 'agent_settled') {
        record.streaming = false
      }
      record.coalescer.push(event)
    }
    const onUiRequest = (request: unknown) => {
      record.pendingUi = true
      this.broadcast(CHAT_CHANNELS.uiRequest, { chatId, request })
    }
    const onExit = ({ code, signal }: { code: number | null; signal: string | null }) => {
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
    }
    const onStderr = (line: string) => {
      // While startup runs, translate known stderr noise (pi-mcp retries)
      // into a "waiting on X" hint next to the starting indicator.
      if (record.ready) {
        return
      }
      const hint = startupHintFromStderr(line)
      if (hint) {
        this.broadcast(CHAT_CHANNELS.hint, { chatId, hint })
      }
    }
    record.listeners = {
      event: onEvent,
      uiRequest: onUiRequest,
      exit: onExit,
      stderr: onStderr
    }
    client.on('event', onEvent)
    client.on('ui-request', onUiRequest)
    client.on('exit', onExit)
    client.on('stderr', onStderr)
  }
}

export function basenameOrHome(cwd: string): string {
  return cwd === homedir() ? '~' : basename(cwd)
}
