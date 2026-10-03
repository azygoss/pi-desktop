import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentMessage, PiEvent } from '../../shared/pi-types'
import { appUserDataDir } from '../config/app-paths'
import type { PiProcessPool } from '../pi/pool'
import type { PiRpcClient } from '../pi/rpc-client'
import { EventCoalescer } from './event-coalescer'
import { requireString, validateCwd, validateMessage, validateSessionPath } from './validation'

export const SIDE_CHANNELS = {
  event: 'pi-desktop:side:event',
  exit: 'pi-desktop:side:exit'
} as const

const SIDE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/
const STARTUP_TIMEOUT_MS = 90_000
const ASK_TIMEOUT_MS = 10 * 60_000

interface SideRecord {
  client: PiRpcClient
  poolId: string
  /** Scratch copy of the chat's session this side chat reads; removed on close. */
  scratch?: string
  coalescer: EventCoalescer
}

export interface SideModel {
  provider: string
  modelId: string
}

function validateSideId(value: unknown): string {
  if (typeof value !== 'string' || !SIDE_ID_RE.test(value)) {
    throw new Error('Invalid side chat id')
  }
  return value
}

function validateModel(value: unknown): SideModel | undefined {
  const m = value as { provider?: unknown; modelId?: unknown } | null | undefined
  return m && typeof m.provider === 'string' && typeof m.modelId === 'string'
    ? { provider: m.provider.slice(0, 128), modelId: m.modelId.slice(0, 256) }
    : undefined
}

/** Text of an assistant message (text blocks only). */
function assistantText(message: AgentMessage): string {
  if (message.role !== 'assistant') {
    return ''
  }
  return message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/**
 * Short-lived pi processes beside a chat:
 *
 * - a **side chat** answers questions with the chat's context but writes
 *   nothing back to it: pi runs on a scratch copy of the session file, which
 *   is removed when the side chat closes;
 * - **ask** runs one prompt in a session-less pi and returns the reply (the
 *   diff panel's review pass).
 *
 * Neither gets the browser / computer tools or a bridge token.
 */
export class SideChatService {
  private readonly sides = new Map<string, SideRecord>()

  constructor(
    private readonly pool: PiProcessPool,
    private readonly broadcast: (channel: string, payload: unknown) => void
  ) {}

  private scratchDir(): string {
    return join(appUserDataDir(), 'side-chats')
  }

  /** Start (or reuse) the side chat's pi. Resolves once pi answers. */
  async open(input: {
    sideId: unknown
    cwd: unknown
    sessionPath?: unknown
    model?: unknown
  }): Promise<void> {
    const sideId = validateSideId(input.sideId)
    if (this.sides.get(sideId)?.client.isRunning) {
      return
    }
    const cwd = await validateCwd(input.cwd)
    const model = validateModel(input.model)
    let scratch: string | undefined
    if (input.sessionPath !== undefined) {
      const sessionPath = validateSessionPath(input.sessionPath)
      await mkdir(this.scratchDir(), { recursive: true })
      scratch = join(this.scratchDir(), `${randomUUID()}.jsonl`)
      await copyFile(sessionPath, scratch)
    }
    const poolId = `side:${sideId}`
    const client = await this.pool.open(poolId, {
      cwd,
      ...(scratch ? { sessionPath: scratch } : { extraArgs: ['--no-session'] })
    })
    const record: SideRecord = {
      client,
      poolId,
      ...(scratch ? { scratch } : {}),
      coalescer: new EventCoalescer((events) =>
        this.broadcast(SIDE_CHANNELS.event, { sideId, events })
      )
    }
    this.sides.set(sideId, record)
    client.on('event', (event: PiEvent) => record.coalescer.push(event))
    client.on('exit', () => {
      if (this.sides.get(sideId) === record) {
        this.sides.delete(sideId)
        record.coalescer.dispose()
        void this.removeScratch(record)
        this.broadcast(SIDE_CHANNELS.exit, { sideId })
      }
    })
    try {
      await client.request({ type: 'get_state' }, { timeoutMs: STARTUP_TIMEOUT_MS })
      if (model) {
        await client
          .request({ type: 'set_model', provider: model.provider, modelId: model.modelId })
          .catch(() => {}) // the default model still answers
      }
    } catch (error) {
      await this.close({ sideId })
      throw error
    }
  }

  async send(input: { sideId: unknown; message: unknown }): Promise<void> {
    const record = this.sides.get(validateSideId(input.sideId))
    if (!record?.client.isRunning) {
      throw new Error('The side chat is not running')
    }
    await record.client.request({ type: 'prompt', message: validateMessage(input.message) })
  }

  async abort(input: { sideId: unknown }): Promise<void> {
    const record = this.sides.get(validateSideId(input.sideId))
    await record?.client.request({ type: 'abort' }, { timeoutMs: 15_000 }).catch(() => {})
  }

  async close(input: { sideId: unknown }): Promise<void> {
    const sideId = validateSideId(input.sideId)
    const record = this.sides.get(sideId)
    if (!record) {
      return
    }
    this.sides.delete(sideId)
    record.coalescer.dispose()
    await this.pool.close(record.poolId)
    await this.removeScratch(record)
  }

  /** The scratch copy is the app's own temp file, not a user session. */
  private async removeScratch(record: SideRecord): Promise<void> {
    if (record.scratch) {
      await rm(record.scratch, { force: true }).catch(() => {})
    }
  }

  /**
   * Run one prompt in a fresh, session-less pi in `cwd` and return the text
   * of its last reply. The process is gone when this resolves.
   */
  async ask(input: { cwd: unknown; prompt: unknown; model?: unknown }): Promise<string> {
    const cwd = await validateCwd(input.cwd)
    const prompt = requireString(input.prompt, 'prompt', 20_000)
    const model = validateModel(input.model)
    const poolId = `ask:${randomUUID()}`
    const client = await this.pool.open(poolId, { cwd, extraArgs: ['--no-session'] })
    try {
      await client.request({ type: 'get_state' }, { timeoutMs: STARTUP_TIMEOUT_MS })
      if (model) {
        await client
          .request({ type: 'set_model', provider: model.provider, modelId: model.modelId })
          .catch(() => {})
      }
      let reply = ''
      const settled = new Promise<void>((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error('pi took too long')), ASK_TIMEOUT_MS)
        timer.unref?.()
        const finish = (error?: Error): void => {
          clearTimeout(timer)
          if (error) {
            reject(error)
          } else {
            resolvePromise()
          }
        }
        client.on('event', (event: PiEvent) => {
          if (event.type === 'message_end') {
            const text = assistantText(event.message)
            if (text) {
              reply = text
            }
          } else if (event.type === 'agent_settled') {
            finish()
          }
        })
        client.on('exit', () => finish(new Error('pi exited before it answered')))
      })
      await client.request({ type: 'prompt', message: prompt })
      await settled
      return reply
    } finally {
      await this.pool.close(poolId)
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sides.keys()].map((sideId) => this.close({ sideId })))
  }
}
