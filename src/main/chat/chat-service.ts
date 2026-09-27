import { createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  ChatExitPayload,
  ChatOpenInput,
  ChatOpenResult,
  ChatSendInput,
  ChatSessionStats
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
import {
  requireString,
  validateChatId,
  validateCwd,
  validateImages,
  validateMessage,
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
      cwd = await validateCwd(input.cwd)
    }

    const existing = this.chats.get(chatId)
    const client = await this.pool.open(chatId, { cwd, sessionPath })
    if (!existing || existing.client !== client) {
      const record: ChatRecord = { client, chatId, cwd, sessionPath, streaming: false }
      this.chats.set(chatId, record)
      this.attachClient(record)
    }

    const [state, messages, models, thinkingLevels, commands] = await Promise.all([
      client.request<PiSessionState>({ type: 'get_state' }),
      client.request<{ messages: AgentMessage[] }>({ type: 'get_messages' }),
      client.request<{ models: Model[] }>({ type: 'get_available_models' }),
      client.request<{ levels: ThinkingLevel[] }>({ type: 'get_available_thinking_levels' }),
      client.request<{ commands: PiCommandInfo[] }>({ type: 'get_commands' })
    ])

    return {
      chatId,
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

  async setModel(input: { chatId: string; provider: string; modelId: string }): Promise<void> {
    const record = this.requireChat(validateChatId(input.chatId))
    const provider = requireString(input.provider, 'provider', 128)
    const modelId = requireString(input.modelId, 'modelId', 256)
    await record.client.request({ type: 'set_model', provider, modelId })
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

  async setCwd(input: { chatId: string; cwd: string }): Promise<ChatOpenResult> {
    const chatId = validateChatId(input.chatId)
    const cwd = await validateCwd(input.cwd)
    await this.close({ chatId })
    return this.open({ chatId, cwd })
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
