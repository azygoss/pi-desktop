import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { generateKeyPair, type KeyPair } from '../../shared/remote/crypto'
import { parsePairingPayload, toBase64Url, type ServerFrame } from '../../shared/remote/protocol'
import { TestPhone } from '../../../test/fixtures/remote-phone'
import { RemoteServer } from './remote-server'
import { RemoteStore } from './remote-store'

const CHAT_EVENTS = 'chat:event'

describe('RemoteServer', () => {
  let dir: string
  let store: RemoteStore
  let server: RemoteServer
  let changes: number
  let gone: string[]
  const phones: TestPhone[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pi-desktop-remote-'))
    store = new RemoteStore(join(dir, 'remote.json'))
    changes = 0
    gone = []
    server = new RemoteServer({
      store,
      invoke: async (channel, arg) => {
        if (channel === 'echo') {
          return arg
        }
        if (channel === 'big') {
          return { text: 'x'.repeat(50_000) }
        }
        throw new Error('Not available from a paired device')
      },
      forward: { chatEvents: CHAT_EVENTS, channels: new Set(['sessions:changed']) },
      info: () => ({
        name: 'Test Mac',
        version: '1.0.0',
        platform: 'darwin',
        homeDir: '/Users/example',
        workspaceDir: '/Users/example/workspace'
      }),
      onChanged: () => {
        changes++
      },
      onDeviceGone: (deviceId) => gone.push(deviceId),
      deviceGoneMs: 60,
      hosts: () => ['127.0.0.1']
    })
    await server.start()
  })

  afterEach(async () => {
    for (const phone of phones.splice(0)) {
      phone.close()
    }
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  async function pairPhone(identity = generateKeyPair()) {
    const pairing = parsePairingPayload(server.beginPairing().payload)!
    const phone = await TestPhone.connect(pairing, identity, { pair: pairing.token })
    phones.push(phone)
    const ready = await phone.ready()
    return { phone, pairing, identity, ready }
  }

  it('pairs a phone with the one-time code and lists it', async () => {
    const { ready } = await pairPhone()
    expect(ready?.server.name).toBe('Test Mac')
    const status = server.status()
    expect(status.running).toBe(true)
    expect(status.devices).toHaveLength(1)
    expect(status.devices[0]).toMatchObject({ name: 'Test phone', connected: true })
    expect(status.pairingExpiresAt).toBeNull() // the code is spent
    expect(changes).toBeGreaterThan(0)
    // The identity key never lands in the file as the public key does.
    const file = JSON.parse(await readFile(join(dir, 'remote.json'), 'utf8')) as {
      devices: unknown[]
    }
    expect(file.devices).toHaveLength(1)
  })

  it('lets a paired phone reconnect without a code', async () => {
    const { pairing, identity, phone } = await pairPhone()
    phone.close()
    const again = await TestPhone.connect(pairing, identity)
    phones.push(again)
    expect((await again.ready())?.deviceId).toBe(server.status().devices[0]!.id)
  })

  it('turns away strangers and spent or wrong codes', async () => {
    const { pairing } = await pairPhone()
    // No code on screen: an unknown phone is told so, inside the channel.
    const stranger = await TestPhone.connect(pairing, generateKeyPair())
    phones.push(stranger)
    expect(
      await stranger.next((f): f is Extract<ServerFrame, { t: 'denied' }> => f.t === 'denied')
    ).toMatchObject({ reason: 'This phone is not paired with the computer' })
    expect(await stranger.ready()).toBeNull()
    // A code on screen, but the phone presents the old one.
    server.beginPairing()
    const stale = await TestPhone.connect(pairing, generateKeyPair(), { pair: pairing.token })
    phones.push(stale)
    expect(await stale.ready()).toBeNull()
    expect(server.status().devices).toHaveLength(1)
  })

  it('rejects a phone that claims a paired key it does not hold', async () => {
    const { pairing, identity } = await pairPhone()
    const thief: KeyPair = { publicKey: identity.publicKey, secretKey: generateKeyPair().secretKey }
    const phone = await TestPhone.connect(pairing, thief)
    phones.push(phone)
    expect(await phone.ready()).toBeNull()
  })

  it('answers requests, compresses large replies and reports errors', async () => {
    const { phone } = await pairPhone()
    expect(await phone.request(1, 'echo', { a: 1 })).toMatchObject({ ok: true, d: { a: 1 } })
    const big = await phone.request(2, 'big')
    expect(big.ok && (big.d as { text: string }).text.length).toBe(50_000)
    expect(await phone.request(3, 'pi-desktop:app:quit')).toMatchObject({
      ok: false,
      e: 'Not available from a paired device'
    })
  })

  it('sends token deltas only to phones showing the chat', async () => {
    const { phone } = await pairPhone()
    const isEvent = (f: ServerFrame): f is Extract<ServerFrame, { t: 'ev' }> => f.t === 'ev'
    server.broadcast(CHAT_EVENTS, {
      chatId: 'a',
      events: [{ type: 'agent_start' }, { type: 'message_update' }]
    })
    expect((await phone.next(isEvent))?.d).toEqual({ chatId: 'a', events: [{ type: 'agent_start' }] })
    phone.send({ t: 'sub', chats: ['a'] })
    await phone.request(9, 'echo') // the subscription is applied in order
    server.broadcast(CHAT_EVENTS, { chatId: 'a', events: [{ type: 'message_update' }] })
    server.broadcast(CHAT_EVENTS, { chatId: 'b', events: [{ type: 'message_update' }] })
    server.broadcast('sessions:changed', undefined)
    server.broadcast('terminal:data', { id: 't', data: 'secret' })
    expect((await phone.next(isEvent))?.d).toEqual({
      chatId: 'a',
      events: [{ type: 'message_update' }]
    })
    expect(await phone.next(isEvent)).toMatchObject({ ch: 'sessions:changed' })
    expect(phone.frames).toHaveLength(0)
  })

  it('disconnects and forgets a revoked phone', async () => {
    const { phone, pairing, identity } = await pairPhone()
    await server.revoke(server.status().devices[0]!.id)
    expect(await phone.ready()).toBeNull() // socket closed
    expect(server.status().devices).toHaveLength(0)
    const back = await TestPhone.connect(pairing, identity)
    phones.push(back)
    expect(await back.ready()).toBeNull()
  })

  it('reports a phone as gone only when it stays away', async () => {
    const { phone, pairing, identity, ready } = await pairPhone()
    const deviceId = ready!.deviceId
    // Back within the grace period (the phone slept): nothing is cleaned up.
    phone.close()
    await new Promise((r) => setTimeout(r, 20))
    const again = await TestPhone.connect(pairing, identity)
    phones.push(again)
    await again.ready()
    await new Promise((r) => setTimeout(r, 120))
    expect(gone).toEqual([])
    // Gone for good.
    again.close()
    await expect.poll(() => gone, { timeout: 2000 }).toEqual([deviceId])
  })

  it('does not replace an identity it cannot unlock', async () => {
    const file = join(dir, 'locked.json')
    const locked = new RemoteStore(file, {
      available: () => true,
      encrypt: (text) => Buffer.from(text),
      decrypt: (data) => data.toString()
    })
    await locked.load()
    const before = await readFile(file, 'utf8')
    // Same file, but the keychain is not available this time.
    const unavailable = new RemoteStore(file, {
      available: () => false,
      encrypt: (text) => Buffer.from(text),
      decrypt: () => {
        throw new Error('locked')
      }
    })
    await expect(unavailable.load()).rejects.toThrow('could not be unlocked')
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('lists stored phones without starting the host', async () => {
    const { phone } = await pairPhone()
    phone.close()
    await server.stop()
    const store = new RemoteStore(join(dir, 'remote.json'))
    const idle = new RemoteServer({
      store,
      invoke: async () => null,
      forward: { chatEvents: CHAT_EVENTS, channels: new Set() },
      info: () => ({ name: 'Mac', version: '1', platform: 'darwin', homeDir: '/', workspaceDir: '/' })
    })
    expect(idle.status().devices).toHaveLength(0)
    await idle.loadDevices()
    expect(idle.status()).toMatchObject({ running: false, devices: [{ name: 'Test phone' }] })
    // Nothing is created just by looking.
    const empty = new RemoteStore(join(dir, 'none.json'))
    await empty.loadIfPresent()
    await expect(readFile(join(dir, 'none.json'), 'utf8')).rejects.toThrow()
  })

  it('keeps its identity and phones across restarts', async () => {
    const { pairing, identity, phone } = await pairPhone()
    phone.close()
    await server.stop()
    const reloaded = new RemoteStore(join(dir, 'remote.json'))
    await reloaded.load()
    expect(toBase64Url(reloaded.identity.publicKey)).toBe(pairing.key)
    expect(reloaded.deviceByKey(toBase64Url(identity.publicKey))?.name).toBe('Test phone')
  })
})
