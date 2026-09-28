import { createServer, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'

const MAX_BODY_BYTES = 256 * 1024
const TOKEN_BYTES = 32

export interface BridgeCall {
  chatId: string
  tool: string
  params: Record<string, unknown>
}

export type BridgeHandler = (call: BridgeCall) => Promise<unknown>

/**
 * Loopback HTTP bridge that lets per-chat pi processes (via the bundled
 * extension) invoke app services. A random token is issued per chat and
 * injected into that chat's pi env; requests without a valid token are
 * rejected before any dispatch.
 */
export class BridgeServer {
  private server: Server | null = null
  private readonly tokens = new Map<string, string>()
  private readonly tokensByChat = new Map<string, string>()
  private handler: BridgeHandler | null = null
  private baseUrl = ''

  get url(): string {
    return this.baseUrl
  }

  get running(): boolean {
    return this.server !== null
  }

  setHandler(handler: BridgeHandler): void {
    this.handler = handler
  }

  /** Base URL for spawned pi processes; '' until start() resolves. */
  async start(): Promise<string> {
    if (this.server) {
      return this.baseUrl
    }
    const server = createServer((req, res) => {
      void this.handle(req, res)
    })
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolvePromise())
    })
    const address = server.address() as AddressInfo
    this.server = server
    this.baseUrl = `http://127.0.0.1:${address.port}`
    return this.baseUrl
  }

  /** Token for a chat's pi process; stable for the life of the chat. */
  issue(chatId: string): string {
    const existing = this.tokensByChat.get(chatId)
    if (existing) {
      return existing
    }
    const token = randomBytes(TOKEN_BYTES).toString('hex')
    this.tokens.set(token, chatId)
    this.tokensByChat.set(chatId, token)
    return token
  }

  revoke(chatId: string): void {
    const token = this.tokensByChat.get(chatId)
    if (token) {
      this.tokensByChat.delete(chatId)
      this.tokens.delete(token)
    }
  }

  /**
   * Re-map a token onto a different chat id — used when a draft chat adopts
   * the warm spare process, which was spawned with a spare-id token in env.
   */
  adopt(fromChatId: string, toChatId: string): void {
    const token = this.tokensByChat.get(fromChatId)
    if (!token) {
      return
    }
    this.tokensByChat.delete(fromChatId)
    this.tokensByChat.set(toChatId, token)
    this.tokens.set(token, toChatId)
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.baseUrl = ''
    this.tokens.clear()
    this.tokensByChat.clear()
    if (server) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    }
  }

  private chatIdForToken(token: string | undefined): string | null {
    if (!token || token.length !== TOKEN_BYTES * 2 || !/^[0-9a-f]+$/.test(token)) {
      return null
    }
    const provided = Buffer.from(token, 'utf8')
    for (const [issued, chatId] of this.tokens) {
      const stored = Buffer.from(issued, 'utf8')
      if (stored.length === provided.length && timingSafeEqual(stored, provided)) {
        return chatId
      }
    }
    return null
  }

  private async handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse
  ): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      const text = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(text)
    }

    if (req.method !== 'POST' || req.url !== '/call') {
      reply(404, { ok: false, error: 'Not found' })
      return
    }

    const auth = req.headers['authorization'] ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined
    const chatId = this.chatIdForToken(token)
    if (!chatId) {
      reply(401, { ok: false, error: 'Invalid bridge token' })
      return
    }

    let raw = ''
    try {
      raw = await new Promise<string>((resolvePromise, reject) => {
        let size = 0
        req.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            reject(new Error('Request body too large'))
            req.destroy()
            return
          }
          raw += chunk.toString('utf8')
        })
        req.on('end', () => resolvePromise(raw))
        req.on('error', reject)
      })
    } catch {
      reply(413, { ok: false, error: 'Request body too large' })
      return
    }

    let body: { tool?: unknown; params?: unknown }
    try {
      body = JSON.parse(raw) as { tool?: unknown; params?: unknown }
    } catch {
      reply(400, { ok: false, error: 'Invalid JSON' })
      return
    }
    if (
      typeof body.tool !== 'string' ||
      !/^(browser|computer)_[a-z_]{1,32}$/.test(body.tool)
    ) {
      reply(400, { ok: false, error: 'Invalid tool name' })
      return
    }
    const params =
      body.params === null || body.params === undefined
        ? {}
        : typeof body.params === 'object' && !Array.isArray(body.params)
          ? (body.params as Record<string, unknown>)
          : null
    if (params === null) {
      reply(400, { ok: false, error: 'params must be an object' })
      return
    }

    if (!this.handler) {
      reply(503, { ok: false, error: 'Bridge not ready' })
      return
    }
    try {
      const result = await this.handler({ chatId, tool: body.tool, params })
      reply(200, { ok: true, result })
    } catch (error) {
      reply(200, {
        ok: false,
        error: error instanceof Error ? error.message : 'Tool failed'
      })
    }
  }
}
