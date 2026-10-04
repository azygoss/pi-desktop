import { hostname, networkInterfaces } from 'node:os'
import { deflateRawSync } from 'node:zlib'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'

import {
  channelForServer,
  equalBytes,
  generateKeyPair,
  randomBytes,
  serverSessionKeys,
  type SecureChannel
} from '../../shared/remote/crypto'
import {
  COMPRESS_THRESHOLD_BYTES,
  FRAME_DEFLATE,
  FRAME_JSON,
  PAIRING_TTL_MS,
  REMOTE_PROTOCOL_VERSION,
  encodePairingPayload,
  fromBase64Url,
  toBase64Url,
  type ClientFrame,
  type HelloFromClient,
  type HelloFromServer,
  type RemoteServerInfo,
  type ServerFrame
} from '../../shared/remote/protocol'
import type { RemoteDevice, RemoteStore } from './remote-store'

/** A request body carries at most a few images. */
const MAX_FRAME_BYTES = 48 * 1024 * 1024
const HANDSHAKE_TIMEOUT_MS = 10_000
const HEARTBEAT_MS = 25_000
/** A phone this far behind is cut off; it resyncs when it reconnects. */
const MAX_BUFFERED_BYTES = 24 * 1024 * 1024
const MAX_CONNECTIONS = 8
const MAX_FAILURES = 8
const FAILURE_WINDOW_MS = 10 * 60_000
const PORT_ATTEMPTS = 20
/** A phone that dropped off usually comes back (sleep, a network change). */
const DEVICE_GONE_MS = 5 * 60_000

/** Chat event types every paired phone hears, subscribed to the chat or not. */
const STATUS_EVENTS = new Set(['agent_start', 'agent_settled'])

export interface RemoteServerDeps {
  store: RemoteStore
  /** Run a remotely allowed IPC handler. */
  invoke(channel: string, arg: unknown, deviceId: string): Promise<unknown>
  info(): RemoteServerInfo
  /** Broadcast channels phones receive; `chatEvents` is filtered per chat. */
  forward: { channels: ReadonlySet<string>; chatEvents: string }
  /**
   * A phone has been gone for a while (or was removed): whatever it left
   * running on the computer — a side chat's pi — can be cleaned up.
   */
  onDeviceGone?(deviceId: string): void
  /** How long a disconnected phone is given to come back (tests). */
  deviceGoneMs?: number
  /** Devices, connections or pairing changed. */
  onChanged?(): void
  /** Addresses for the pairing code (tests, or the headless host's --host). */
  hosts?(): string[]
  /** Port to try first instead of the stored one. */
  port?: number
  /** Ports tried, counting up from the first (default PORT_ATTEMPTS). */
  portAttempts?: number
  /** Interface to listen on (default: all IPv4 interfaces). */
  bind?: string
}

export interface RemoteStatus {
  running: boolean
  port: number | null
  /** Addresses a phone can reach this computer at. */
  addresses: string[]
  devices: (Omit<RemoteDevice, 'publicKey'> & { connected: boolean })[]
  pairingExpiresAt: number | null
  error?: string
}

interface Connection {
  socket: WebSocket
  ip: string
  state: 'hello' | 'auth' | 'ready' | 'closed'
  channel?: SecureChannel
  clientKey?: string
  deviceId?: string
  /** Chats whose full event stream this phone asked for. */
  chats: Set<string>
  alive: boolean
  timer: ReturnType<typeof setTimeout> | null
}

function isPrivateLan(address: string): boolean {
  return (
    address.startsWith('192.168.') ||
    address.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  )
}

/** This computer's addresses, the home network's first. */
export function localHosts(): string[] {
  const lan: string[] = []
  const other: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) {
        continue
      }
      ;(isPrivateLan(entry.address) ? lan : other).push(entry.address)
    }
  }
  const name = hostname()
  const mdns = name ? (name.endsWith('.local') ? name : `${name}.local`) : ''
  return [...lan, ...other, ...(mdns && /^[A-Za-z0-9.-]+$/.test(mdns) ? [mdns] : [])].slice(0, 8)
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return Buffer.concat(data)
  }
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data
}

function encodeFrame(frame: ServerFrame): Buffer {
  const json = Buffer.from(JSON.stringify(frame), 'utf8')
  if (json.length > COMPRESS_THRESHOLD_BYTES) {
    return Buffer.concat([Buffer.from([FRAME_DEFLATE]), deflateRawSync(json, { level: 4 })])
  }
  return Buffer.concat([Buffer.from([FRAME_JSON]), json])
}

function decodeFrame(plain: Uint8Array): ClientFrame | null {
  try {
    // Phones send plain JSON frames (compression is for the large replies
    // going the other way), so nothing a phone sends is ever inflated here.
    if (plain[0] !== FRAME_JSON) {
      return null
    }
    const body = Buffer.from(plain.buffer, plain.byteOffset + 1, plain.length - 1)
    const frame = JSON.parse(body.toString('utf8')) as ClientFrame | null
    return frame !== null && typeof frame === 'object' && typeof frame.t === 'string' ? frame : null
  } catch {
    return null
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

/**
 * The remote-control host: a WebSocket server paired phones connect to.
 * After the encrypted handshake (see shared/remote/crypto.ts) a phone sends
 * requests that run the desktop's own IPC handlers and receives the
 * desktop's broadcasts, so it sees and does what the window can.
 */
export class RemoteServer {
  private server: WebSocketServer | null = null
  private listeningPort: number | null = null
  private readonly connections = new Set<Connection>()
  private readonly failures = new Map<string, { count: number; resetAt: number }>()
  private pairing: { token: Uint8Array; expiresAt: number } | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private lastError: string | undefined
  /** Phones with no connection left, and when they count as gone. */
  private readonly goneTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Serializes start/stop so a quick off-on cannot leave two servers. */
  private transition: Promise<void> = Promise.resolve()

  constructor(private readonly deps: RemoteServerDeps) {}

  get running(): boolean {
    return this.server !== null
  }

  start(): Promise<void> {
    this.transition = this.transition.catch(() => {}).then(() => this.doStart())
    return this.transition
  }

  stop(): Promise<void> {
    this.transition = this.transition.catch(() => {}).then(() => this.doStop())
    return this.transition
  }

  private async doStart(): Promise<void> {
    if (this.server) {
      return
    }
    try {
      await this.deps.store.load()
    } catch (error) {
      this.lastError = errorText(error)
      this.deps.onChanged?.()
      throw error
    }
    const first = this.deps.port ?? this.deps.store.port
    let lastError: unknown
    for (let i = 0; i < (this.deps.portAttempts ?? PORT_ATTEMPTS); i++) {
      const port = first + i > 65535 ? 1024 + i : first + i
      try {
        this.server = await this.listen(port)
        this.listeningPort = port
        await this.deps.store.setPort(port)
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!this.server) {
      this.lastError = `Could not open a port: ${errorText(lastError)}`
      this.deps.onChanged?.()
      throw new Error(this.lastError)
    }
    this.lastError = undefined
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS)
    this.heartbeat.unref?.()
    this.deps.onChanged?.()
  }

  private listen(port: number): Promise<WebSocketServer> {
    return new Promise((resolvePromise, reject) => {
      const server = new WebSocketServer({
        host: this.deps.bind ?? '0.0.0.0',
        port,
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false
      })
      server.once('error', (error) => {
        server.close()
        reject(error)
      })
      server.once('listening', () => {
        server.removeAllListeners('error')
        server.on('error', () => {})
        server.on('connection', (socket, request) =>
          this.accept(socket, request.socket.remoteAddress ?? '')
        )
        resolvePromise(server)
      })
    })
  }

  private async doStop(): Promise<void> {
    const server = this.server
    this.server = null
    this.listeningPort = null
    this.pairing = null
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    for (const connection of this.connections) {
      this.drop(connection)
    }
    // No phone can come back to a host that is off.
    for (const deviceId of [...this.goneTimers.keys()]) {
      this.clearGone(deviceId)
      this.deps.onDeviceGone?.(deviceId)
    }
    if (server) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    }
    this.deps.onChanged?.()
  }

  /** Read the stored pairings (if any) so they can be shown with the host off. */
  loadDevices(): Promise<void> {
    return this.deps.store.loadIfPresent()
  }

  status(): RemoteStatus {
    const connected = new Set(
      [...this.connections].filter((c) => c.state === 'ready').map((c) => c.deviceId)
    )
    const pairing = this.activePairing()
    return {
      running: this.running,
      port: this.listeningPort,
      addresses: this.running ? this.hosts() : [],
      devices: this.deps.store.devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        pairedAt: d.pairedAt,
        ...(d.lastSeenAt !== undefined ? { lastSeenAt: d.lastSeenAt } : {}),
        connected: connected.has(d.id)
      })),
      pairingExpiresAt: pairing?.expiresAt ?? null,
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  private hosts(): string[] {
    return this.deps.hosts?.() ?? localHosts()
  }

  private activePairing(): { token: Uint8Array; expiresAt: number } | null {
    if (this.pairing && this.pairing.expiresAt <= Date.now()) {
      this.pairing = null
    }
    return this.pairing
  }

  /** A fresh one-time pairing link; the previous one stops working. */
  beginPairing(): { payload: string; expiresAt: number } {
    if (!this.running || this.listeningPort === null) {
      throw new Error('Remote control is off')
    }
    const hosts = this.hosts()
    if (hosts.length === 0) {
      throw new Error('This computer is not on a network')
    }
    this.pairing = { token: randomBytes(16), expiresAt: Date.now() + PAIRING_TTL_MS }
    this.deps.onChanged?.()
    return {
      payload: encodePairingPayload({
        key: toBase64Url(this.deps.store.identity.publicKey),
        token: toBase64Url(this.pairing.token),
        port: this.listeningPort,
        hosts,
        name: this.deps.info().name
      }),
      expiresAt: this.pairing.expiresAt
    }
  }

  cancelPairing(): void {
    if (this.pairing) {
      this.pairing = null
      this.deps.onChanged?.()
    }
  }

  /** Forget a phone and cut its connections. */
  async revoke(deviceId: string): Promise<void> {
    await this.deps.store.removeDevice(deviceId)
    for (const connection of this.connections) {
      if (connection.deviceId === deviceId) {
        this.drop(connection)
      }
    }
    // Removed for good: nothing of its is waited for.
    this.clearGone(deviceId)
    this.deps.onDeviceGone?.(deviceId)
    this.deps.onChanged?.()
  }

  /** Forward one of the desktop's broadcasts to the phones that want it. */
  broadcast(channel: string, payload: unknown): void {
    if (this.connections.size === 0) {
      return
    }
    const { channels, chatEvents } = this.deps.forward
    if (channel === chatEvents) {
      this.broadcastChatEvents(channel, payload as { chatId: string; events: { type: string }[] })
      return
    }
    if (!channels.has(channel)) {
      return
    }
    let frame: Buffer | null = null
    for (const connection of this.connections) {
      if (connection.state === 'ready') {
        frame ??= encodeFrame({ t: 'ev', ch: channel, d: payload ?? null })
        this.sendEncoded(connection, frame)
      }
    }
  }

  /**
   * Token deltas only go to phones showing that chat; the rest hear just
   * when a run starts and settles, which is all a chat list needs.
   */
  private broadcastChatEvents(
    channel: string,
    payload: { chatId: string; events: { type: string }[] }
  ): void {
    let full: Buffer | null = null
    let status: Buffer | null | undefined
    for (const connection of this.connections) {
      if (connection.state !== 'ready') {
        continue
      }
      if (connection.chats.has(payload.chatId)) {
        full ??= encodeFrame({ t: 'ev', ch: channel, d: payload })
        this.sendEncoded(connection, full)
        continue
      }
      if (status === undefined) {
        const events = payload.events.filter((e) => STATUS_EVENTS.has(e.type))
        status =
          events.length > 0
            ? encodeFrame({ t: 'ev', ch: channel, d: { chatId: payload.chatId, events } })
            : null
      }
      if (status) {
        this.sendEncoded(connection, status)
      }
    }
  }

  private accept(socket: WebSocket, ip: string): void {
    if (this.connections.size >= MAX_CONNECTIONS || this.blocked(ip)) {
      socket.terminate()
      return
    }
    const connection: Connection = {
      socket,
      ip,
      state: 'hello',
      chats: new Set(),
      alive: true,
      timer: setTimeout(() => this.drop(connection), HANDSHAKE_TIMEOUT_MS)
    }
    this.connections.add(connection)
    socket.on('message', (data, isBinary) => {
      void this.receive(connection, data, isBinary).catch(() => this.drop(connection))
    })
    socket.on('pong', () => {
      connection.alive = true
    })
    socket.on('error', () => this.drop(connection))
    socket.on('close', () => this.drop(connection))
  }

  private blocked(ip: string): boolean {
    const entry = this.failures.get(ip)
    if (entry && entry.resetAt <= Date.now()) {
      this.failures.delete(ip)
      return false
    }
    return (entry?.count ?? 0) >= MAX_FAILURES
  }

  private fail(connection: Connection): void {
    const now = Date.now()
    const entry = this.failures.get(connection.ip)
    if (entry && entry.resetAt > now) {
      entry.count++
    } else {
      this.failures.set(connection.ip, { count: 1, resetAt: now + FAILURE_WINDOW_MS })
    }
    this.drop(connection)
  }

  private drop(connection: Connection): void {
    if (connection.state === 'closed') {
      return
    }
    const wasReady = connection.state === 'ready'
    connection.state = 'closed'
    if (connection.timer) {
      clearTimeout(connection.timer)
      connection.timer = null
    }
    this.connections.delete(connection)
    connection.socket.terminate()
    if (wasReady) {
      if (connection.deviceId) {
        this.watchGone(connection.deviceId)
      }
      this.deps.onChanged?.()
    }
  }

  /** Start the clock on a phone with no connection left. */
  private watchGone(deviceId: string): void {
    for (const other of this.connections) {
      if (other.deviceId === deviceId && other.state === 'ready') {
        return
      }
    }
    this.clearGone(deviceId)
    const timer = setTimeout(() => {
      this.goneTimers.delete(deviceId)
      this.deps.onDeviceGone?.(deviceId)
    }, this.deps.deviceGoneMs ?? DEVICE_GONE_MS)
    timer.unref?.()
    this.goneTimers.set(deviceId, timer)
  }

  private clearGone(deviceId: string): boolean {
    const timer = this.goneTimers.get(deviceId)
    if (timer) {
      clearTimeout(timer)
      this.goneTimers.delete(deviceId)
    }
    return timer !== undefined
  }

  private beat(): void {
    for (const connection of this.connections) {
      if (connection.state !== 'ready') {
        continue
      }
      if (!connection.alive) {
        this.drop(connection)
        continue
      }
      connection.alive = false
      connection.socket.ping()
    }
  }

  private async receive(connection: Connection, data: RawData, isBinary: boolean): Promise<void> {
    if (connection.state === 'hello') {
      if (isBinary) {
        this.fail(connection)
        return
      }
      this.hello(connection, toBytes(data))
      return
    }
    if (!isBinary || !connection.channel) {
      this.fail(connection)
      return
    }
    const plain = connection.channel.open(toBytes(data))
    const frame = plain && plain.length > 0 ? decodeFrame(plain) : null
    if (!frame) {
      // A frame that does not open means a wrong key or tampering.
      this.fail(connection)
      return
    }
    if (connection.state === 'auth') {
      await this.authenticate(connection, frame)
      return
    }
    connection.alive = true
    switch (frame.t) {
      case 'ping':
        this.send(connection, { t: 'pong' })
        return
      case 'sub':
        connection.chats = new Set(
          Array.isArray(frame.chats)
            ? frame.chats.filter((c): c is string => typeof c === 'string').slice(0, 32)
            : []
        )
        return
      case 'req':
        await this.request(connection, frame)
        return
      default:
        return
    }
  }

  private hello(connection: Connection, data: Uint8Array): void {
    let hello: HelloFromClient
    let clientStatic: Uint8Array
    let clientEphemeral: Uint8Array
    try {
      hello = JSON.parse(Buffer.from(data).toString('utf8')) as HelloFromClient
      if (hello.v !== REMOTE_PROTOCOL_VERSION) {
        throw new Error('Unsupported version')
      }
      clientStatic = fromBase64Url(hello.c)
      clientEphemeral = fromBase64Url(hello.e)
    } catch {
      this.fail(connection)
      return
    }
    try {
      const serverEphemeral = generateKeyPair()
      const keys = serverSessionKeys({
        serverStatic: this.deps.store.identity,
        serverEphemeral,
        clientStaticPublic: clientStatic,
        clientEphemeralPublic: clientEphemeral
      })
      serverEphemeral.secretKey.fill(0)
      connection.channel = channelForServer(keys)
      connection.clientKey = hello.c
      connection.state = 'auth'
      const reply: HelloFromServer = {
        v: REMOTE_PROTOCOL_VERSION,
        e: toBase64Url(serverEphemeral.publicKey)
      }
      connection.socket.send(JSON.stringify(reply))
    } catch {
      this.fail(connection)
    }
  }

  private async authenticate(connection: Connection, frame: ClientFrame): Promise<void> {
    if (frame.t !== 'auth' || !connection.clientKey) {
      this.fail(connection)
      return
    }
    let device = this.deps.store.deviceByKey(connection.clientKey)
    if (!device) {
      const pairing = this.activePairing()
      let token: Uint8Array | null
      try {
        token = typeof frame.pair === 'string' ? fromBase64Url(frame.pair) : null
      } catch {
        token = null
      }
      if (!pairing || !token || !equalBytes(token, pairing.token)) {
        // Said inside the encrypted channel, so the phone knows it is this
        // computer speaking and can stop retrying (it was removed here).
        this.send(connection, { t: 'denied', reason: 'This phone is not paired with the computer' })
        if (token) {
          this.fail(connection) // a wrong code counts toward the lockout
        } else {
          connection.socket.close()
          this.drop(connection)
        }
        return
      }
      this.pairing = null // one phone per code
      device = await this.deps.store.addDevice({
        name: typeof frame.device?.name === 'string' ? frame.device.name : 'Phone',
        platform: typeof frame.device?.platform === 'string' ? frame.device.platform : '',
        publicKey: connection.clientKey
      })
    } else {
      void this.deps.store.markSeen(device.id).catch(() => {})
    }
    if (connection.timer) {
      clearTimeout(connection.timer)
      connection.timer = null
    }
    connection.deviceId = device.id
    this.clearGone(device.id)
    connection.state = 'ready'
    this.failures.delete(connection.ip)
    this.send(connection, { t: 'ready', deviceId: device.id, server: { ...this.deps.info(), hosts: this.hosts() } })
    this.deps.onChanged?.()
  }

  private async request(
    connection: Connection,
    frame: Extract<ClientFrame, { t: 'req' }>
  ): Promise<void> {
    if (typeof frame.id !== 'number' || typeof frame.ch !== 'string') {
      return
    }
    try {
      const data = await this.deps.invoke(frame.ch, frame.a, connection.deviceId ?? '')
      this.send(connection, { t: 'res', id: frame.id, ok: true, d: data ?? null })
    } catch (error) {
      this.send(connection, { t: 'res', id: frame.id, ok: false, e: errorText(error) })
    }
  }

  private send(connection: Connection, frame: ServerFrame): void {
    this.sendEncoded(connection, encodeFrame(frame))
  }

  private sendEncoded(connection: Connection, encoded: Buffer): void {
    if (!connection.channel || connection.state === 'closed' || connection.state === 'hello') {
      return
    }
    if (connection.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.drop(connection)
      return
    }
    // Sealing advances this connection's counter, so it happens per phone.
    connection.socket.send(connection.channel.seal(encoded), { binary: true })
  }
}
