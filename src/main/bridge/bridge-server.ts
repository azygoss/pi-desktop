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
 * extension) invoke app services. A random token is issued per pi process
 * and injected into its env; requests without a valid token are rejected
 * before any dispatch. The token answers as a chat id, which moves when a
 * warm spare is adopted.
 */
export class BridgeServer {
  private server: Server | null = null
  /** token → chat id the process currently answers as */
  private readonly tokens = new Map<string, string>()
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

  /** A fresh token for one pi process, answering as `chatId`. */
  issue(chatId: string): string {
    const token = randomBytes(TOKEN_BYTES).toString('hex')
    this.tokens.set(token, chatId)
    return token
  }

  revoke(token: string): void {
    this.tokens.delete(token)
  }

  /** Point a live token at another chat id (a warm spare was adopted). */
  assign(token: string, chatId: string): void {
    if (this.tokens.has(token)) {
      this.tokens.set(token, chatId)
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.baseUrl = ''
    this.tokens.clear()
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
