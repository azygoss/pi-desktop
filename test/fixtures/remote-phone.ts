import { inflateRawSync } from 'node:zlib'
import { WebSocket } from 'ws'

import {
  channelForClient,
  clientSessionKeys,
  generateKeyPair,
  type KeyPair,
  type SecureChannel
} from '../../src/shared/remote/crypto'
import {
  FRAME_DEFLATE,
  FRAME_JSON,
  fromBase64Url,
  remoteUrl,
  toBase64Url,
  type ClientFrame,
  type HelloFromServer,
  type PairingPayload,
  type ServerFrame
} from '../../src/shared/remote/protocol'

/** A minimal phone: the same handshake and framing the app uses. */
export class TestPhone {
  readonly frames: ServerFrame[] = []
  private waiters: (() => void)[] = []
  private channel: SecureChannel | null = null
  closed = false

  private constructor(private readonly socket: WebSocket) {}

  static async connect(
    pairing: PairingPayload,
    identity: KeyPair,
    auth: { pair?: string } = {}
  ): Promise<TestPhone> {
    const socket = new WebSocket(remoteUrl('127.0.0.1', pairing.port))
    const phone = new TestPhone(socket)
    socket.on('close', () => {
      phone.closed = true
      phone.wake()
    })
    socket.on('error', () => {})
    await new Promise<void>((resolvePromise, reject) => {
      socket.once('open', () => resolvePromise())
      socket.once('error', reject)
    })
    const ephemeral = generateKeyPair()
    const reply = new Promise<HelloFromServer>((resolvePromise, reject) => {
      socket.once('message', (data) => resolvePromise(JSON.parse(String(data)) as HelloFromServer))
      socket.once('close', () => reject(new Error('closed during handshake')))
    })
    socket.send(
      JSON.stringify({
        v: 1,
        c: toBase64Url(identity.publicKey),
        e: toBase64Url(ephemeral.publicKey)
      })
    )
    const hello = await reply
    phone.channel = channelForClient(
      clientSessionKeys({
        clientStatic: identity,
        clientEphemeral: ephemeral,
        serverStaticPublic: fromBase64Url(pairing.key),
        serverEphemeralPublic: fromBase64Url(hello.e)
      })
    )
    socket.on('message', (data) => {
      const plain = phone.channel!.open(new Uint8Array(data as Buffer))
      if (!plain) {
        return
      }
      const body = Buffer.from(plain.subarray(1))
      const json = plain[0] === FRAME_DEFLATE ? inflateRawSync(body) : body
      phone.frames.push(JSON.parse(json.toString('utf8')) as ServerFrame)
      phone.wake()
    })
    phone.send({ t: 'auth', device: { name: 'Test phone', platform: 'android' }, ...auth })
    return phone
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter()
    }
  }

  send(frame: ClientFrame): void {
    const json = Buffer.from(JSON.stringify(frame))
    this.socket.send(this.channel!.seal(Buffer.concat([Buffer.from([FRAME_JSON]), json])))
  }

  /** The next frame matching `match`, or null if the socket closes first. */
  async next<T extends ServerFrame>(match: (frame: ServerFrame) => frame is T): Promise<T | null> {
    for (;;) {
      const index = this.frames.findIndex(match)
      if (index >= 0) {
        return this.frames.splice(index, 1)[0] as T
      }
      if (this.closed) {
        return null
      }
      await new Promise<void>((resolvePromise) => this.waiters.push(resolvePromise))
    }
  }

  ready(): Promise<Extract<ServerFrame, { t: 'ready' }> | null> {
    return this.next((f): f is Extract<ServerFrame, { t: 'ready' }> => f.t === 'ready')
  }

  async request(id: number, ch: string, a?: unknown): Promise<Extract<ServerFrame, { t: 'res' }>> {
    this.send({ t: 'req', id, ch, a })
    const res = await this.next(
      (f): f is Extract<ServerFrame, { t: 'res' }> => f.t === 'res' && f.id === id
    )
    return res!
  }

  close(): void {
    this.socket.terminate()
  }
}
