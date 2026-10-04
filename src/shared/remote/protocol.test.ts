import { describe, expect, it } from 'vitest'

import {
  channelForClient,
  channelForServer,
  clientSessionKeys,
  generateKeyPair,
  serverSessionKeys
} from './crypto'
import {
  encodePairingPayload,
  fromBase64Url,
  parsePairingPayload,
  remoteUrl,
  toBase64Url
} from './protocol'

describe('base64url', () => {
  it('round-trips every length', () => {
    for (let length = 0; length < 70; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff)
      expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes))
    }
  })

  it('rejects other alphabets', () => {
    expect(() => fromBase64Url('ab+/')).toThrow()
    expect(() => fromBase64Url('abcde')).toThrow()
  })
})

describe('pairing payload', () => {
  const payload = {
    key: toBase64Url(new Uint8Array(32).fill(7)),
    token: toBase64Url(new Uint8Array(16).fill(9)),
    port: 47821,
    hosts: ['192.168.1.20', 'studio.local'],
    name: 'Studio Mac'
  }

  it('round-trips', () => {
    expect(parsePairingPayload(encodePairingPayload(payload))).toEqual(payload)
  })

  it('rejects malformed links', () => {
    const link = encodePairingPayload(payload)
    expect(parsePairingPayload('https://example.com')).toBeNull()
    expect(parsePairingPayload(link.replace('v=1', 'v=2'))).toBeNull()
    expect(parsePairingPayload(link.replace('p=47821', 'p=0'))).toBeNull()
    expect(parsePairingPayload(link.replace(/k=[^&]+/, 'k=short'))).toBeNull()
    expect(parsePairingPayload(link.replace(/h=[^&]+/, 'h='))).toBeNull()
  })

  it('brackets IPv6 hosts', () => {
    expect(remoteUrl('192.168.1.20', 47821)).toBe('ws://192.168.1.20:47821')
    expect(remoteUrl('fe80::1', 47821)).toBe('ws://[fe80::1]:47821')
  })
})

describe('session', () => {
  function pair() {
    const serverStatic = generateKeyPair()
    const clientStatic = generateKeyPair()
    const serverEphemeral = generateKeyPair()
    const clientEphemeral = generateKeyPair()
    const client = clientSessionKeys({
      clientStatic,
      clientEphemeral,
      serverStaticPublic: serverStatic.publicKey,
      serverEphemeralPublic: serverEphemeral.publicKey
    })
    const server = serverSessionKeys({
      serverStatic,
      serverEphemeral,
      clientStaticPublic: clientStatic.publicKey,
      clientEphemeralPublic: clientEphemeral.publicKey
    })
    return { client, server, serverStatic, clientStatic, serverEphemeral, clientEphemeral }
  }

  it('derives the same keys on both sides', () => {
    const { client, server } = pair()
    expect(Array.from(client.clientToServer)).toEqual(Array.from(server.clientToServer))
    expect(Array.from(client.serverToClient)).toEqual(Array.from(server.serverToClient))
    expect(Array.from(client.clientToServer)).not.toEqual(Array.from(client.serverToClient))
  })

  it('does not agree with an impostor desktop', () => {
    const { serverEphemeral, clientStatic, clientEphemeral, client } = pair()
    const impostor = serverSessionKeys({
      serverStatic: generateKeyPair(),
      serverEphemeral,
      clientStaticPublic: clientStatic.publicKey,
      clientEphemeralPublic: clientEphemeral.publicKey
    })
    expect(Array.from(impostor.clientToServer)).not.toEqual(Array.from(client.clientToServer))
  })

  it('rejects a low-order public key', () => {
    const serverStatic = generateKeyPair()
    expect(() =>
      serverSessionKeys({
        serverStatic,
        serverEphemeral: generateKeyPair(),
        clientStaticPublic: new Uint8Array(32),
        clientEphemeralPublic: generateKeyPair().publicKey
      })
    ).toThrow()
  })

  it('opens frames in order and refuses replays', () => {
    const { client, server } = pair()
    const phone = channelForClient(client)
    const desktop = channelForServer(server)
    const first = phone.seal(new TextEncoder().encode('one'))
    const second = phone.seal(new TextEncoder().encode('two'))
    expect(new TextDecoder().decode(desktop.open(first)!)).toBe('one')
    expect(desktop.open(first)).toBeNull() // replay
    expect(new TextDecoder().decode(desktop.open(second)!)).toBe('two')
    const reply = desktop.seal(new TextEncoder().encode('ok'))
    expect(new TextDecoder().decode(phone.open(reply)!)).toBe('ok')
    // A frame sealed for the other direction never opens.
    expect(desktop.open(desktop.seal(new Uint8Array(4)))).toBeNull()
  })
})
