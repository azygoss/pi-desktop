import * as Device from 'expo-device'
import { AppState } from 'react-native'
import { create } from 'zustand'

import { parsePairingPayload, type KeyPair, type RemoteServerInfo } from '../desktop'
import { RemoteClient, RemoteDeniedError, RemoteDisconnectedError } from '../remote/client'
import { loadIdentity, loadPairing, savePairing, type StoredPairing } from '../remote/storage'

export type ConnectionPhase = 'loading' | 'unpaired' | 'connecting' | 'online' | 'offline'

interface ConnectionState {
  phase: ConnectionPhase
  pairing: StoredPairing | null
  server: RemoteServerInfo | null
  /** Why the last attempt failed, in words for the user. */
  error: string | null
  /** Load the stored pairing and connect. Once, at launch. */
  init(): Promise<void>
  /** Pair with the computer whose QR code (or pasted link) this is. */
  pair(text: string): Promise<void>
  /** Forget the computer. */
  unpair(): Promise<void>
  /** Try again now instead of waiting for the next automatic attempt. */
  retry(): void
  /** Add an address to try (the computer moved to another network). */
  addHost(host: string): Promise<void>
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000]

let identity: KeyPair | null = null
let client: RemoteClient | null = null
let attempt = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
let connecting = false
let subscribedChats: string[] = []

let backgroundLink = false

/**
 * Whether the link is kept up with the app in the background (the keep-alive
 * service is running: timers work and redialing makes sense).
 */
export function setBackgroundLink(on: boolean): void {
  backgroundLink = on
}

function mayDial(): boolean {
  return AppState.currentState === 'active' || backgroundLink
}

type Listener = (payload: unknown) => void
const listeners = new Map<string, Set<Listener>>()
const onlineListeners = new Set<() => void>()

function deviceInfo(): { name: string; platform: string } {
  return {
    name: (Device.deviceName ?? Device.modelName ?? 'Android phone').slice(0, 64),
    platform: 'android'
  }
}

/** Listen to one of the desktop's broadcasts; survives reconnects. */
export function onRemote<T>(channel: string, listener: (payload: T) => void): () => void {
  let set = listeners.get(channel)
  if (!set) {
    set = new Set()
    listeners.set(channel, set)
  }
  set.add(listener as Listener)
  return () => set.delete(listener as Listener)
}

/** Runs every time the link comes (back) up: the moment to resync. */
export function onOnline(listener: () => void): () => void {
  onlineListeners.add(listener)
  return () => onlineListeners.delete(listener)
}

const unpairListeners = new Set<() => void>()

/** Runs when the pairing ends: everything learned from that computer goes. */
export function onUnpair(listener: () => void): () => void {
  unpairListeners.add(listener)
  return () => unpairListeners.delete(listener)
}

function forget(): void {
  subscribedChats = []
  for (const listener of unpairListeners) {
    listener()
  }
}

/** Run one of the desktop's IPC handlers. Rejects at once while offline. */
export function request<T>(channel: string, arg?: unknown, timeoutMs?: number): Promise<T> {
  if (!client?.connected) {
    return Promise.reject(new RemoteDisconnectedError())
  }
  return client.request<T>(channel, arg, timeoutMs)
}

/** Chats whose token stream this phone wants; remembered across reconnects. */
export function subscribeChats(chatIds: string[]): void {
  subscribedChats = chatIds
  client?.subscribe(chatIds)
}

function clearRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

function scheduleRetry(): void {
  clearRetry()
  // No point dialing while the app sleeps in the background; resuming reconnects.
  if (!mayDial()) {
    return
  }
  const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!
  attempt++
  retryTimer = setTimeout(() => void connect(), wait)
}

/**
 * Dial the paired computer. With `candidate` (and its one-time `token`) this
 * is a pairing attempt: nothing is stored or shown as paired until the
 * computer accepts.
 */
async function connect(token?: string, candidate?: StoredPairing): Promise<void> {
  const pairing = candidate ?? useConnection.getState().pairing
  if (!pairing || !identity || connecting) {
    if (candidate) {
      throw new Error('Already connecting. Try again in a moment.')
    }
    return
  }
  connecting = true
  clearRetry()
  client?.close()
  if (!candidate && useConnection.getState().phase !== 'offline') {
    useConnection.setState({ phase: 'connecting' })
  }
  const next = new RemoteClient(identity)
  client = next
  // The address that worked last goes first; the rest stay as fallbacks.
  const hosts = pairing.lastHost
    ? [pairing.lastHost, ...pairing.hosts.filter((h) => h !== pairing.lastHost)]
    : pairing.hosts
  try {
    const result = await next.connect({
      key: pairing.key,
      port: pairing.port,
      hosts,
      device: deviceInfo(),
      ...(token ? { token } : {})
    })
    if (client !== next) {
      next.close()
      return
    }
    attempt = 0
    next.onEvent = (channel, payload) => {
      const set = listeners.get(channel)
      if (set) {
        for (const listener of set) {
          listener(payload)
        }
      }
    }
    next.onClose = () => {
      if (client === next) {
        client = null
        // Usually the phone slept or changed network: redial at once and
        // only call it offline if that fails.
        useConnection.setState({ phase: 'connecting', error: null })
        attempt = 0
        if (mayDial()) {
          void connect().catch(() => {})
        }
      }
    }
    // The computer reports its addresses on every connection: keep them, so
    // it is still found after its address changes or on another network.
    const known = [
      ...new Set([result.host, ...(result.server.hosts ?? []), ...pairing.hosts])
    ].slice(0, 16)
    const updated: StoredPairing = {
      ...pairing,
      hosts: known,
      name: result.server.name,
      lastHost: result.host
    }
    if (
      updated.lastHost !== pairing.lastHost ||
      updated.name !== pairing.name ||
      known.join() !== pairing.hosts.join()
    ) {
      void savePairing(updated).catch(() => {})
    }
    useConnection.setState({ phase: 'online', server: result.server, pairing: updated, error: null })
    if (subscribedChats.length > 0) {
      next.subscribe(subscribedChats)
    }
    for (const listener of onlineListeners) {
      listener()
    }
  } catch (error) {
    if (client === next) {
      client = null
    }
    next.close()
    if (error instanceof RemoteDeniedError) {
      // Removed on the computer (or the code was spent): pairing is over.
      await savePairing(null).catch(() => {})
      forget()
      useConnection.setState({
        phase: 'unpaired',
        pairing: null,
        server: null,
        error: candidate
          ? 'That code no longer works. Show a new one on the computer and scan again.'
          : 'This phone was removed on the computer. Pair it again to continue.'
      })
      throw error
    }
    const unreachable =
      'Cannot reach the computer. Check that Pi Desktop is open with remote control on (or pi-remote is running on the server), and that this phone can reach it.'
    if (candidate) {
      useConnection.setState({ error: unreachable })
      throw new Error(unreachable)
    }
    useConnection.setState({ phase: 'offline', error: unreachable })
    scheduleRetry()
  } finally {
    connecting = false
  }
}

export const useConnection = create<ConnectionState>((set, get) => ({
  phase: 'loading',
  pairing: null,
  server: null,
  error: null,

  async init() {
    identity = await loadIdentity()
    const pairing = await loadPairing()
    if (!pairing) {
      set({ phase: 'unpaired' })
      return
    }
    set({ pairing, phase: 'connecting' })
    void connect().catch(() => {})
  },

  async pair(text) {
    const payload = parsePairingPayload(text)
    if (!payload) {
      throw new Error('That is not a Pi Desktop pairing code')
    }
    identity ??= await loadIdentity()
    const pairing: StoredPairing = {
      key: payload.key,
      port: payload.port,
      hosts: payload.hosts,
      name: payload.name
    }
    set({ error: null })
    await connect(payload.token, pairing)
    if (get().phase !== 'online') {
      throw new Error(get().error ?? 'Could not reach the computer')
    }
    await savePairing(get().pairing)
  },

  async unpair() {
    clearRetry()
    const current = client
    client = null
    current?.close()
    await savePairing(null).catch(() => {})
    forget()
    set({ phase: 'unpaired', pairing: null, server: null, error: null })
  },

  retry() {
    if (get().pairing && get().phase !== 'online') {
      attempt = 0
      void connect().catch(() => {})
    }
  },

  async addHost(host) {
    const pairing = get().pairing
    const clean = host.trim().replace(/^wss?:\/\//, '').replace(/[:/].*$/, '')
    if (!pairing || !/^[A-Za-z0-9.-]{1,255}$/.test(clean)) {
      throw new Error('That is not an address')
    }
    const updated = { ...pairing, hosts: [clean, ...pairing.hosts.filter((h) => h !== clean)] }
    set({ pairing: updated })
    await savePairing(updated)
    if (get().phase !== 'online') {
      attempt = 0
      void connect().catch(() => {})
    }
  }
}))

// Android suspends sockets of a backgrounded app: come back, check, redial.
AppState.addEventListener('change', (state) => {
  if (state !== 'active') {
    if (!backgroundLink) {
      clearRetry()
    }
    return
  }
  const { phase, pairing } = useConnection.getState()
  if (!pairing) {
    return
  }
  if (phase === 'online' && client?.connected) {
    // A dead socket can still look open; a request that times out closes it.
    void client.request('pi-desktop:app:info', undefined, 4000).catch(() => client?.close())
    return
  }
  attempt = 0
  void connect().catch(() => {})
})
