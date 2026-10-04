import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  generateKeyPair,
  keyPairFromSecret,
  type KeyPair
} from '../../shared/remote/crypto'
import {
  DEFAULT_REMOTE_PORT,
  fromBase64Url,
  toBase64Url
} from '../../shared/remote/protocol'

/** A phone that paired with this computer. */
export interface RemoteDevice {
  id: string
  name: string
  platform: string
  /** Static public key, base64url. */
  publicKey: string
  pairedAt: number
  lastSeenAt?: number
}

/**
 * Encrypts the identity key at rest (Electron safeStorage: the OS keychain).
 * Without one the key is stored as is, in a file only the user can read.
 */
export interface SecretProtector {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

interface StoredSecret {
  enc: 'safe' | 'plain'
  value: string
}

interface RemoteFile {
  secretKey: StoredSecret
  port: number
  devices: RemoteDevice[]
}

const MAX_DEVICES = 16

function cleanDevices(value: unknown): RemoteDevice[] {
  if (!Array.isArray(value)) {
    return []
  }
  const devices: RemoteDevice[] = []
  for (const item of value) {
    const d = item as Partial<RemoteDevice> | null
    if (
      d &&
      typeof d.id === 'string' &&
      typeof d.name === 'string' &&
      typeof d.publicKey === 'string' &&
      typeof d.pairedAt === 'number'
    ) {
      devices.push({
        id: d.id,
        name: d.name.slice(0, 64),
        platform: typeof d.platform === 'string' ? d.platform.slice(0, 32) : '',
        publicKey: d.publicKey,
        pairedAt: d.pairedAt,
        ...(typeof d.lastSeenAt === 'number' ? { lastSeenAt: d.lastSeenAt } : {})
      })
    }
  }
  return devices.slice(0, MAX_DEVICES)
}

/**
 * The computer's remote-control identity and its paired phones, kept in the
 * app's own data directory (`remote.json`), never in pi's.
 */
export class RemoteStore {
  private keys: KeyPair | null = null
  private portValue = DEFAULT_REMOTE_PORT
  private deviceList: RemoteDevice[] = []
  private loaded = false
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly protector?: SecretProtector
  ) {}

  /** Read the file, creating the identity on first use. */
  async load(): Promise<void> {
    if (this.loaded) {
      return
    }
    let stored: Partial<RemoteFile> | null
    try {
      stored = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<RemoteFile>
    } catch {
      stored = null
    }
    const secret = this.readSecret(stored?.secretKey)
    this.keys = secret ? keyPairFromSecret(secret) : generateKeyPair()
    const port = Number(stored?.port)
    this.portValue =
      Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_REMOTE_PORT
    // A new identity cannot be reached by phones paired with the old one.
    this.deviceList = secret ? cleanDevices(stored?.devices) : []
    this.loaded = true
    if (!secret) {
      await this.persist()
    }
  }

  private readSecret(stored: StoredSecret | undefined): Uint8Array | null {
    try {
      if (!stored || typeof stored.value !== 'string') {
        return null
      }
      if (stored.enc === 'safe') {
        if (!this.protector?.available()) {
          return null
        }
        return fromBase64Url(this.protector.decrypt(Buffer.from(stored.value, 'base64')))
      }
      const bytes = fromBase64Url(stored.value)
      return bytes.length === 32 ? bytes : null
    } catch {
      return null
    }
  }

  private writeSecret(): StoredSecret {
    const text = toBase64Url(this.identity.secretKey)
    if (this.protector?.available()) {
      return { enc: 'safe', value: this.protector.encrypt(text).toString('base64') }
    }
    return { enc: 'plain', value: text }
  }

  private persist(): Promise<void> {
    const file: RemoteFile = {
      secretKey: this.writeSecret(),
      port: this.portValue,
      devices: this.deviceList
    }
    const text = JSON.stringify(file, null, 2) + '\n'
    // Writes are chained so a slow one cannot land after a newer one.
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true })
        await writeFile(this.filePath, text, { mode: 0o600 })
      })
    return this.writing
  }

  get identity(): KeyPair {
    if (!this.keys) {
      throw new Error('Remote store is not loaded')
    }
    return this.keys
  }

  get port(): number {
    return this.portValue
  }

  async setPort(port: number): Promise<void> {
    if (port !== this.portValue) {
      this.portValue = port
      await this.persist()
    }
  }

  get devices(): readonly RemoteDevice[] {
    return this.deviceList
  }

  deviceByKey(publicKey: string): RemoteDevice | undefined {
    return this.deviceList.find((d) => d.publicKey === publicKey)
  }

  async addDevice(input: { name: string; platform: string; publicKey: string }): Promise<RemoteDevice> {
    const device: RemoteDevice = {
      id: randomUUID(),
      name: input.name.trim().slice(0, 64) || 'Phone',
      platform: input.platform.slice(0, 32),
      publicKey: input.publicKey,
      pairedAt: Date.now(),
      lastSeenAt: Date.now()
    }
    // Oldest pairing makes room; a phone that pairs again replaces itself.
    this.deviceList = [
      ...this.deviceList.filter((d) => d.publicKey !== input.publicKey),
      device
    ].slice(-MAX_DEVICES)
    await this.persist()
    return device
  }

  async removeDevice(id: string): Promise<boolean> {
    const next = this.deviceList.filter((d) => d.id !== id)
    if (next.length === this.deviceList.length) {
      return false
    }
    this.deviceList = next
    await this.persist()
    return true
  }

  async markSeen(id: string, at = Date.now()): Promise<void> {
    const device = this.deviceList.find((d) => d.id === id)
    if (device) {
      device.lastSeenAt = at
      await this.persist()
    }
  }
}
