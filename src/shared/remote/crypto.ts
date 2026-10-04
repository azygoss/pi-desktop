import nacl from 'tweetnacl'

/**
 * End-to-end encryption for the remote-control link (desktop ⇄ phone).
 *
 * The transport is a plain WebSocket on the local network, so everything
 * above the handshake is sealed here. Both sides hold a long-term X25519 key
 * pair: the desktop's public key reaches the phone inside the pairing QR
 * code, the phone's is registered on the desktop when it pairs.
 *
 * Handshake (one round trip, both messages in the clear):
 *   phone   → { c: static public, e: ephemeral public }
 *   desktop → { e: ephemeral public }
 * Session keys come from three Diffie-Hellman results — ephemeral/ephemeral
 * (forward secrecy), phone-ephemeral/desktop-static (proves the desktop) and
 * phone-static/desktop-ephemeral (proves the phone) — hashed together with
 * every public key. Frames are then XSalsa20-Poly1305 boxes with an implicit
 * per-direction counter as the nonce, so replayed, dropped or reordered
 * frames fail to open.
 */

export const KEY_BYTES = 32
const CONTEXT = 'pi-desktop-remote-v1'

export interface KeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

/** Random source override for runtimes without `crypto.getRandomValues`. */
export function setRandomSource(fill: (target: Uint8Array) => void): void {
  nacl.setPRNG((target, length) => {
    const bytes = new Uint8Array(length)
    fill(bytes)
    target.set(bytes)
    bytes.fill(0)
  })
}

export function randomBytes(length: number): Uint8Array {
  return nacl.randomBytes(length)
}

export function generateKeyPair(): KeyPair {
  return nacl.box.keyPair()
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  if (secretKey.length !== KEY_BYTES) {
    throw new Error('Invalid secret key')
  }
  return nacl.box.keyPair.fromSecretKey(secretKey)
}

function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== KEY_BYTES) {
    throw new Error('Invalid public key')
  }
  const shared = nacl.scalarMult(secretKey, publicKey)
  // A low-order point yields all zeros: the peer contributed nothing.
  let acc = 0
  for (const byte of shared) {
    acc |= byte
  }
  if (acc === 0) {
    throw new Error('Invalid public key')
  }
  return shared
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) {
    length += part.length
  }
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i) & 0x7f
  }
  return out
}

export interface SessionKeys {
  /** Key for frames the phone sends. */
  clientToServer: Uint8Array
  /** Key for frames the desktop sends. */
  serverToClient: Uint8Array
}

function derive(
  serverStatic: Uint8Array,
  clientStatic: Uint8Array,
  clientEphemeral: Uint8Array,
  serverEphemeral: Uint8Array,
  shared: Uint8Array[]
): SessionKeys {
  const digest = nacl.hash(
    concat([
      asciiBytes(CONTEXT),
      serverStatic,
      clientStatic,
      clientEphemeral,
      serverEphemeral,
      ...shared
    ])
  )
  for (const secret of shared) {
    secret.fill(0)
  }
  return {
    clientToServer: digest.slice(0, KEY_BYTES),
    serverToClient: digest.slice(KEY_BYTES, KEY_BYTES * 2)
  }
}

/** Phone side of the handshake. */
export function clientSessionKeys(input: {
  clientStatic: KeyPair
  clientEphemeral: KeyPair
  serverStaticPublic: Uint8Array
  serverEphemeralPublic: Uint8Array
}): SessionKeys {
  const { clientStatic, clientEphemeral, serverStaticPublic, serverEphemeralPublic } = input
  return derive(
    serverStaticPublic,
    clientStatic.publicKey,
    clientEphemeral.publicKey,
    serverEphemeralPublic,
    [
      dh(clientEphemeral.secretKey, serverEphemeralPublic),
      dh(clientEphemeral.secretKey, serverStaticPublic),
      dh(clientStatic.secretKey, serverEphemeralPublic)
    ]
  )
}

/** Desktop side of the handshake. */
export function serverSessionKeys(input: {
  serverStatic: KeyPair
  serverEphemeral: KeyPair
  clientStaticPublic: Uint8Array
  clientEphemeralPublic: Uint8Array
}): SessionKeys {
  const { serverStatic, serverEphemeral, clientStaticPublic, clientEphemeralPublic } = input
  return derive(
    serverStatic.publicKey,
    clientStaticPublic,
    clientEphemeralPublic,
    serverEphemeral.publicKey,
    [
      dh(serverEphemeral.secretKey, clientEphemeralPublic),
      dh(serverStatic.secretKey, clientEphemeralPublic),
      dh(serverEphemeral.secretKey, clientStaticPublic)
    ]
  )
}

/**
 * One direction-pair of an established session. Counters are implicit: the
 * n-th frame sent is sealed with nonce n, and the receiver only accepts the
 * n-th frame it reads. WebSocket delivery is ordered, so a mismatch means
 * tampering and the caller must drop the connection.
 */
export class SecureChannel {
  private sendCounter = 0
  private receiveCounter = 0
  private readonly sendNonce = new Uint8Array(nacl.secretbox.nonceLength)
  private readonly receiveNonce = new Uint8Array(nacl.secretbox.nonceLength)

  constructor(
    private readonly sendKey: Uint8Array,
    private readonly receiveKey: Uint8Array
  ) {}

  private static writeCounter(nonce: Uint8Array, counter: number): void {
    let value = counter
    for (let i = nonce.length - 1; i >= nonce.length - 8; i--) {
      nonce[i] = value % 256
      value = Math.floor(value / 256)
    }
  }

  seal(plain: Uint8Array): Uint8Array {
    SecureChannel.writeCounter(this.sendNonce, this.sendCounter++)
    return nacl.secretbox(plain, this.sendNonce, this.sendKey)
  }

  /** Null when the frame is forged, replayed or out of order. */
  open(box: Uint8Array): Uint8Array | null {
    SecureChannel.writeCounter(this.receiveNonce, this.receiveCounter)
    const plain = nacl.secretbox.open(box, this.receiveNonce, this.receiveKey)
    if (plain) {
      this.receiveCounter++
    }
    return plain
  }
}

export function channelForClient(keys: SessionKeys): SecureChannel {
  return new SecureChannel(keys.clientToServer, keys.serverToClient)
}

export function channelForServer(keys: SessionKeys): SecureChannel {
  return new SecureChannel(keys.serverToClient, keys.clientToServer)
}

/** Constant-time comparison of two byte strings. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && nacl.verify(a, b)
}
