import { getRandomValues } from 'expo-crypto'
import { inflateRaw } from 'pako'

import {
  FRAME_DEFLATE,
  FRAME_JSON,
  REMOTE_PROTOCOL_VERSION,
  channelForClient,
  clientSessionKeys,
  fromBase64Url,
  generateKeyPair,
  remoteUrl,
  setRandomSource,
  toBase64Url,
  type ClientFrame,
  type HelloFromServer,
  type KeyPair,
  type RemoteServerInfo,
  type SecureChannel,
  type ServerFrame
} from '../desktop'

// Hermes has no crypto.getRandomValues of its own; keys come from the OS.
setRandomSource((target) => {
  getRandomValues(target)
})

const OPEN_TIMEOUT_MS = 3500
/** Delay before the next address is dialed alongside the previous one. */
const STAGGER_MS = 500
const HANDSHAKE_TIMEOUT_MS = 8000
const REQUEST_TIMEOUT_MS = 30_000
const PING_INTERVAL_MS = 20_000
/** No frame for this long means the link is dead even if the socket says open. */
const SILENCE_LIMIT_MS = 50_000

export class RemoteDeniedError extends Error {}
export class RemoteDisconnectedError extends Error {
  constructor() {
    super('Not connected to the computer')
  }
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export interface ConnectTarget {
  /** Desktop's static public key (base64url). */
  key: string
  port: number
  hosts: string[]
  /** One-time pairing token, on the first connection only. */
  token?: string
  device: { name: string; platform: string }
}

export interface Connected {
  host: string
  deviceId: string
  server: RemoteServerInfo
}

const encoder = new TextEncoder()

function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(bytes)
  }
  // Fallback for runtimes without TextDecoder.
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i++]!
    let code = b
    if (b >= 0xf0) {
      code = ((b & 0x07) << 18) | ((bytes[i++]! & 0x3f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f)
    } else if (b >= 0xe0) {
      code = ((b & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f)
    } else if (b >= 0xc0) {
      code = ((b & 0x1f) << 6) | (bytes[i++]! & 0x3f)
    }
    out += String.fromCodePoint(code)
  }
  return out
}

function decodeFrame(plain: Uint8Array): ServerFrame | null {
  try {
    const body = plain.subarray(1)
    const json =
      plain[0] === FRAME_DEFLATE
        ? (inflateRaw(body, { toText: true }) as string)
        : plain[0] === FRAME_JSON
          ? utf8Decode(body)
          : null
    return json === null ? null : (JSON.parse(json) as ServerFrame)
  } catch {
    return null
  }
}

/**
 * One encrypted connection to the paired computer: the handshake, request /
 * response correlation and event fan-out. Reconnecting is the caller's
 * business (see state/connection.ts) — a client is used for one socket.
 */
export class RemoteClient {
  private socket: WebSocket | null = null
  private channel: SecureChannel | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private lastFrameAt = 0
  private closed = false
  /** Cancels for handshakes still in flight (addresses are raced). */
  private readonly attempts = new Set<() => void>()
  /** Settles a race of addresses that is still under way. */
  private abortRace: (() => void) | null = null
  onClose: (() => void) | null = null
  /** One of the desktop's broadcasts arrived. */
  onEvent: ((channel: string, payload: unknown) => void) | null = null

  constructor(private readonly identity: KeyPair) {}

  get connected(): boolean {
    return this.channel !== null && !this.closed
  }

  /**
   * Reach the computer at one of its addresses. Pairing tries them in turn
   * (the one-time token must not be presented twice); a paired phone dials
   * them staggered and keeps the first that completes the handshake, so a
   * stale first address costs half a second, not a timeout.
   */
  async connect(target: ConnectTarget): Promise<Connected> {
    if (target.token || target.hosts.length <= 1) {
      let lastError: Error = new RemoteDisconnectedError()
      for (const host of target.hosts) {
        if (this.closed) {
          break
        }
        try {
          return await this.connectTo(host, target)
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
          if (error instanceof RemoteDeniedError) {
            break // the computer answered and said no: other addresses will too
          }
        }
      }
      throw lastError
    }
    return new Promise<Connected>((resolve, reject) => {
      let remaining = target.hosts.length
      let done = false
      let denied: Error | null = null
      const timers: ReturnType<typeof setTimeout>[] = []
      const finish = (result: Connected | null, error?: Error): void => {
        if (done) {
          return
        }
        done = true
        this.abortRace = null
        timers.forEach(clearTimeout)
        for (const cancel of [...this.attempts]) {
          cancel()
        }
        if (result) {
          resolve(result)
        } else {
          reject(error ?? new RemoteDisconnectedError())
        }
      }
      this.abortRace = () => finish(null, new RemoteDisconnectedError())
      target.hosts.forEach((host, index) => {
        timers.push(
          setTimeout(() => {
            if (done) {
              return
            }
            if (this.closed) {
              finish(null, new RemoteDisconnectedError())
              return
            }
            this.connectTo(host, target).then(
              (result) => finish(result),
              (error: Error) => {
                if (error instanceof RemoteDeniedError) {
                  denied = error
                }
                remaining -= 1
                if (remaining === 0) {
                  finish(null, denied ?? error)
                }
              }
            )
          }, index * STAGGER_MS)
        )
      })
    })
  }

  private connectTo(host: string, target: ConnectTarget): Promise<Connected> {
    return new Promise<Connected>((resolve, reject) => {
      const socket = new WebSocket(remoteUrl(host, target.port))
      socket.binaryType = 'arraybuffer'
      const ephemeral = generateKeyPair()
      let channel: SecureChannel | null = null
      let settled = false
      let timer = setTimeout(() => fail(new Error('The computer did not answer')), OPEN_TIMEOUT_MS)

      const cancel = (): void => fail(new RemoteDisconnectedError())
      const fail = (error: Error): void => {
        if (settled) {
          return
        }
        settled = true
        this.attempts.delete(cancel)
        clearTimeout(timer)
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
        try {
          socket.close()
        } catch {
          // already closed
        }
        reject(error)
      }

      this.attempts.add(cancel)

      socket.onopen = () => {
        clearTimeout(timer)
        timer = setTimeout(() => fail(new Error('The computer did not answer')), HANDSHAKE_TIMEOUT_MS)
        socket.send(
          JSON.stringify({
            v: REMOTE_PROTOCOL_VERSION,
            c: toBase64Url(this.identity.publicKey),
            e: toBase64Url(ephemeral.publicKey)
          })
        )
      }
      socket.onerror = () => fail(new Error('Could not reach the computer'))
      // Only a sealed `denied` frame is the computer saying no; a bare close
      // could be anything on that address.
      socket.onclose = () => fail(new Error('Could not reach the computer'))
      socket.onmessage = (event) => {
        try {
          if (!channel) {
            if (typeof event.data !== 'string') {
              throw new Error('Unexpected reply')
            }
            const hello = JSON.parse(event.data) as HelloFromServer
            if (hello.v !== REMOTE_PROTOCOL_VERSION || typeof hello.e !== 'string') {
              throw new Error('Pi Desktop and this app are different versions')
            }
            channel = channelForClient(
              clientSessionKeys({
                clientStatic: this.identity,
                clientEphemeral: ephemeral,
                serverStaticPublic: fromBase64Url(target.key),
                serverEphemeralPublic: fromBase64Url(hello.e)
              })
            )
            ephemeral.secretKey.fill(0)
            this.sendOn(socket, channel, {
              t: 'auth',
              device: target.device,
              ...(target.token ? { pair: target.token } : {})
            } as ClientFrame)
            return
          }
          const plain =
            event.data instanceof ArrayBuffer ? channel.open(new Uint8Array(event.data)) : null
          const frame = plain ? decodeFrame(plain) : null
          if (!frame) {
            throw new Error('The computer sent something this app cannot read')
          }
          if (frame.t === 'denied') {
            fail(new RemoteDeniedError(frame.reason))
            return
          }
          if (frame.t !== 'ready') {
            return
          }
          if (this.socket) {
            fail(new RemoteDisconnectedError()) // another address won the race
            return
          }
          settled = true
          this.attempts.delete(cancel)
          clearTimeout(timer)
          this.adopt(socket, channel)
          resolve({ host, deviceId: frame.deviceId, server: frame.server })
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })
  }

  private adopt(socket: WebSocket, channel: SecureChannel): void {
    if (this.closed) {
      socket.close()
      return
    }
    this.socket = socket
    this.channel = channel
    this.lastFrameAt = Date.now()
    socket.onmessage = (event) => this.receive(event.data)
    socket.onerror = () => this.close()
    socket.onclose = () => this.close()
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastFrameAt > SILENCE_LIMIT_MS) {
        this.close()
        return
      }
      this.send({ t: 'ping' })
    }, PING_INTERVAL_MS)
  }

  private receive(data: unknown): void {
    const plain =
      data instanceof ArrayBuffer && this.channel ? this.channel.open(new Uint8Array(data)) : null
    const frame = plain ? decodeFrame(plain) : null
    if (!frame) {
      this.close() // a frame that does not open: the stream cannot be trusted
      return
    }
    this.lastFrameAt = Date.now()
    if (frame.t === 'res') {
      const pending = this.pending.get(frame.id)
      if (pending) {
        this.pending.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.ok) {
          pending.resolve(frame.d ?? undefined)
        } else {
          pending.reject(new Error(frame.e))
        }
      }
      return
    }
    if (frame.t === 'ev') {
      this.onEvent?.(frame.ch, frame.d)
    }
  }

  private sendOn(socket: WebSocket, channel: SecureChannel, frame: ClientFrame): void {
    const json = encoder.encode(JSON.stringify(frame))
    const plain = new Uint8Array(json.length + 1)
    plain[0] = FRAME_JSON
    plain.set(json, 1)
    const sealed = channel.seal(plain)
    socket.send(sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength) as ArrayBuffer)
  }

  private send(frame: ClientFrame): boolean {
    if (!this.socket || !this.channel || this.closed) {
      return false
    }
    try {
      this.sendOn(this.socket, this.channel, frame)
      return true
    } catch {
      this.close()
      return false
    }
  }

  /** Run one of the desktop's IPC handlers. */
  request<T>(channel: string, arg?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The computer took too long to answer'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      if (!this.send({ t: 'req', id, ch: channel, ...(arg !== undefined ? { a: arg } : {}) })) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new RemoteDisconnectedError())
      }
    })
  }

  /** Ask for the full event stream of these chats (replaces the last set). */
  subscribe(chatIds: string[]): void {
    this.send({ t: 'sub', chats: chatIds })
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.abortRace?.()
    for (const cancel of [...this.attempts]) {
      cancel()
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    const socket = this.socket
    this.socket = null
    this.channel = null
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      try {
        socket.close()
      } catch {
        // already closed
      }
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new RemoteDisconnectedError())
    }
    this.pending.clear()
    this.onClose?.()
  }
}
