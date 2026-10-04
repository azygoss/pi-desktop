/**
 * Wire protocol of the remote-control link. The phone speaks the desktop's
 * own IPC vocabulary: a request names an IPC channel the desktop allows
 * remotely and carries that channel's input; events are the desktop's
 * broadcasts, forwarded under their channel names.
 */

export const REMOTE_PROTOCOL_VERSION = 1
export const PAIRING_SCHEME = 'pidesktop'
export const PAIRING_TTL_MS = 5 * 60_000
export const DEFAULT_REMOTE_PORT = 47821

/** Frames larger than this are deflated before sealing. */
export const COMPRESS_THRESHOLD_BYTES = 1024
/** First plaintext byte of every sealed frame. */
export const FRAME_JSON = 0
export const FRAME_DEFLATE = 1

/** Remote-only channels (the rest are the desktop's IPC channel names). */
export const REMOTE_CHANNELS = {
  /** Chats with a live pi process: who is working, who is waiting on you. */
  liveChats: 'pi-desktop:remote:live-chats',
  /** Sub-directories of a folder on the computer (the project picker). */
  listDirs: 'pi-desktop:remote:list-dirs',
  /** Broadcast: an extension dialog was answered (from any device). */
  uiResolved: 'pi-desktop:chat:ui-resolved'
} as const

export interface RemoteLiveChat {
  chatId: string
  cwd: string
  sessionPath?: string
  streaming: boolean
  /** The extension dialog pi is waiting on, when there is one. */
  uiRequest?: unknown
}

export interface RemoteDirListing {
  path: string
  /** Null at the filesystem root. */
  parent: string | null
  dirs: string[]
  /** True when the folder is a git repository. */
  repo: boolean
}

export interface RemoteServerInfo {
  /** The computer's name, as shown in the phone's header. */
  name: string
  version: string
  platform: string
  homeDir: string
  workspaceDir: string
  /**
   * The computer's addresses right now. The phone keeps them, so it still
   * finds the computer after its address changed or on another network.
   */
  hosts?: string[]
}

/** Plaintext handshake, phone → desktop. */
export interface HelloFromClient {
  v: number
  /** Phone's static public key (base64url). */
  c: string
  /** Phone's ephemeral public key (base64url). */
  e: string
}

/** Plaintext handshake, desktop → phone. */
export interface HelloFromServer {
  v: number
  /** Desktop's ephemeral public key (base64url). */
  e: string
}

export type ClientFrame =
  | {
      t: 'auth'
      device: { name: string; platform: string }
      /** One-time token from the QR code, on the first connection only. */
      pair?: string
    }
  | { t: 'req'; id: number; ch: string; a?: unknown }
  /** Chats whose full event stream this phone wants. */
  | { t: 'sub'; chats: string[] }
  | { t: 'ping' }

export type ServerFrame =
  | { t: 'ready'; deviceId: string; server: RemoteServerInfo }
  | { t: 'denied'; reason: string }
  | { t: 'res'; id: number; ok: true; d?: unknown }
  | { t: 'res'; id: number; ok: false; e: string }
  | { t: 'ev'; ch: string; d: unknown }
  | { t: 'pong' }

/** What the pairing QR code carries. */
export interface PairingPayload {
  /** Desktop's static public key (base64url). */
  key: string
  /** One-time pairing token (base64url). */
  token: string
  port: number
  /** Addresses to try, most likely first. */
  hosts: string[]
  name: string
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const BASE64URL_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < BASE64URL.length; i++) {
    table[BASE64URL.charCodeAt(i)] = i
  }
  return table
})()

export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out +=
      BASE64URL[(n >> 18) & 63]! +
      BASE64URL[(n >> 12) & 63]! +
      BASE64URL[(n >> 6) & 63]! +
      BASE64URL[n & 63]!
  }
  if (i + 1 === bytes.length) {
    const n = bytes[i]! << 16
    out += BASE64URL[(n >> 18) & 63]! + BASE64URL[(n >> 12) & 63]!
  } else if (i + 2 === bytes.length) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += BASE64URL[(n >> 18) & 63]! + BASE64URL[(n >> 12) & 63]! + BASE64URL[(n >> 6) & 63]!
  }
  return out
}

/** Throws on anything that is not unpadded base64url. */
export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) {
    throw new Error('Invalid base64url')
  }
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let bits = 0
  let value = 0
  let offset = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const digit = code < 128 ? BASE64URL_LOOKUP[code]! : -1
    if (digit < 0) {
      throw new Error('Invalid base64url')
    }
    value = (value << 6) | digit
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[offset++] = (value >> bits) & 0xff
    }
  }
  return out
}

const HOST_RE = /^[A-Za-z0-9.\-:[\]]{1,255}$/

export function encodePairingPayload(payload: PairingPayload): string {
  const params = [
    `v=${REMOTE_PROTOCOL_VERSION}`,
    `k=${payload.key}`,
    `t=${payload.token}`,
    `p=${payload.port}`,
    `h=${payload.hosts.map(encodeURIComponent).join(',')}`,
    `n=${encodeURIComponent(payload.name)}`
  ]
  return `${PAIRING_SCHEME}://pair?${params.join('&')}`
}

/** Null when the text is not a pairing link this version understands. */
export function parsePairingPayload(text: string): PairingPayload | null {
  const prefix = `${PAIRING_SCHEME}://pair?`
  const trimmed = text.trim()
  if (!trimmed.startsWith(prefix) || trimmed.length > 2048) {
    return null
  }
  const fields = new Map<string, string>()
  for (const pair of trimmed.slice(prefix.length).split('&')) {
    const at = pair.indexOf('=')
    if (at > 0) {
      fields.set(pair.slice(0, at), pair.slice(at + 1))
    }
  }
  try {
    if (Number(fields.get('v')) !== REMOTE_PROTOCOL_VERSION) {
      return null
    }
    const key = fields.get('k') ?? ''
    const token = fields.get('t') ?? ''
    const port = Number(fields.get('p'))
    const hosts = (fields.get('h') ?? '')
      .split(',')
      .map((h) => decodeURIComponent(h))
      .filter((h) => HOST_RE.test(h))
      .slice(0, 12)
    if (
      fromBase64Url(key).length !== 32 ||
      fromBase64Url(token).length < 16 ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      hosts.length === 0
    ) {
      return null
    }
    const name = decodeURIComponent(fields.get('n') ?? '').slice(0, 80) || 'Computer'
    return { key, token, port, hosts, name }
  } catch {
    return null
  }
}

/** `ws://host:port` for a host from the pairing payload (IPv6 gets brackets). */
export function remoteUrl(host: string, port: number): string {
  const bare = host.replace(/^\[|\]$/g, '')
  return `ws://${bare.includes(':') ? `[${bare}]` : bare}:${port}`
}
