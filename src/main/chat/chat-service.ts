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
  ThinkingLevel
} from '../../shared/pi-types'
import type { PiRpcClient } from '../pi/rpc-client'
import { PiProcessPool } from '../pi/pool'
import { ensureWorkspaceDir, workspaceDir } from '../config/app-paths'
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

export const CHAT_CHANNELS = {
  event: 'pi-desktop:chat:event',
  uiRequest: 'pi-desktop:chat:ui-request',
  exit: 'pi-desktop:chat:exit'
} as const

interface ChatRecord {
  client: PiRpcClient
  chatId: string
  cwd: string
  sessionPath?: string
  streaming: boolean
}

const EXIT_STDERR_LINES = 20

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

  constructor(
    private readonly pool: PiProcessPool,
    private readonly broadcast: ChatBroadcast
  ) {}

  async open(input: ChatOpenInput): Promise<ChatOpenResult> {
    const chatId = validateChatId(input.chatId)
    const sessionPath =
      input.sessionPath !== undefined ? validateSessionPath(input.sessionPath) : undefined

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

    const existing = this.chats.get(chatId)
    const client = await this.pool.open(chatId, { cwd, sessionPath })
    if (!existing || existing.client !== client) {
      const record: ChatRecord = { client, chatId, cwd, sessionPath, streaming: false }
      this.chats.set(chatId, record)
      this.attachClient(record)
    }

    return this.fetchCatalog(client, chatId, cwd, sessionPath)
  }

  /** Re-fetch state/messages/models for an already-open chat. */
  async refresh(input: { chatId: string }): Promise<ChatOpenResult> {
    const record = this.requireChat(validateChatId(input.chatId))
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
    const record = this.requireChat(chatId)

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
    const record = this.requireChat(validateChatId(input.chatId))
    await record.client.request({ type: 'abort' }, { timeoutMs: 15000 })
  }

  async setModel(input: {
    chatId: string
    provider: string
    modelId: string
  }): Promise<SetModelResult> {
    const record = this.requireChat(validateChatId(input.chatId))
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
    const record = this.requireChat(validateChatId(input.chatId))
    const level = requireString(input.level, 'level', 32) as ThinkingLevel
    await record.client.request({ type: 'set_thinking_level', level })
  }

  async getStats(input: { chatId: string }): Promise<ChatSessionStats | undefined> {
    const record = this.requireChat(validateChatId(input.chatId))
    return record.client.request<ChatSessionStats>({ type: 'get_session_stats' })
  }

  async compact(input: { chatId: string; customInstructions?: string }): Promise<void> {
    const record = this.requireChat(validateChatId(input.chatId))
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
    const record = this.requireChat(validateChatId(input.chatId))
    const name = requireString(input.name, 'name', 200)
    await record.client.request({ type: 'set_session_name', name })
  }

  async exportHtml(input: { chatId: string; outputPath: string }): Promise<{ path?: string }> {
    const record = this.requireChat(validateChatId(input.chatId))
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

  async getForkMessages(input: {
    chatId: string
  }): Promise<{ messages: { entryId: string; text: string }[] }> {
    const record = this.requireChat(validateChatId(input.chatId))
    const result = await record.client.request<{
      messages?: { entryId: string; text: string }[]
    }>({ type: 'get_fork_messages' })
    return { messages: result?.messages ?? [] }
  }

  async fork(input: {
    chatId: string
    entryId: string
  }): Promise<{ text?: string; cancelled?: boolean }> {
    const record = this.requireChat(validateChatId(input.chatId))
    const entryId = requireString(input.entryId, 'entryId', 256)
    return (
      (await record.client.request<{ text?: string; cancelled?: boolean }>({
        type: 'fork',
        entryId
      })) ?? {}
    )
  }

  async clone(input: { chatId: string }): Promise<{ cancelled?: boolean }> {
    const record = this.requireChat(validateChatId(input.chatId))
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
    const record = this.requireChat(validateChatId(input.chatId))
    const id = requireString(input.id, 'ui request id', 128)
    record.client.respondUi({
      id,
      ...(typeof input.value === 'string' ? { value: input.value } : {}),
      ...(typeof input.confirmed === 'boolean' ? { confirmed: input.confirmed } : {}),
      ...(input.cancelled === true ? { cancelled: true } : {})
    })
  }

  async close(input: { chatId: string }): Promise<void> {
    const chatId = validateChatId(input.chatId)
    this.chats.delete(chatId)
    await this.pool.close(chatId)
  }

  async closeAll(): Promise<void> {
    this.chats.clear()
    await this.pool.closeAll()
  }

  private requireChat(chatId: string): ChatRecord {
    const record = this.chats.get(chatId)
    if (!record || !record.client.isRunning) {
      throw new Error(`No running pi process for chat ${chatId}`)
    }
    return record
  }

  private attachClient(record: ChatRecord): void {
    const { client, chatId } = record
    client.on('event', (event: PiEvent) => {
      if (event.type === 'agent_start') {
        record.streaming = true
      } else if (event.type === 'agent_settled') {
        record.streaming = false
      }
      this.broadcast(CHAT_CHANNELS.event, { chatId, event })
    })
    client.on('ui-request', (request) => {
      this.broadcast(CHAT_CHANNELS.uiRequest, { chatId, request })
    })
    client.on('exit', ({ code, signal }) => {
      this.chats.delete(chatId)
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
