import * as Device from 'expo-device'
import { AppState } from 'react-native'
import { create } from 'zustand'

import { parsePairingPayload, type KeyPair, type RemoteServerInfo } from '../desktop'
import { RemoteClient, RemoteDeniedError, RemoteDisconnectedError } from '../remote/client'
import {
  loadComputers,
  loadIdentity,
  MAX_COMPUTERS,
  saveComputers,
  type StoredPairing
} from '../remote/storage'

export type ConnectionPhase = 'loading' | 'unpaired' | 'connecting' | 'online' | 'offline'

interface ConnectionState {
  phase: ConnectionPhase
  /** The computer in use. */
  pairing: StoredPairing | null
  /** Every paired computer, the one in use included. */
  computers: StoredPairing[]
  server: RemoteServerInfo | null
  /** Why the last attempt failed, in words for the user. */
  error: string | null
  /** Load the stored pairings and connect. Once, at launch. */
  init(): Promise<void>
  /** Pair with the computer whose QR code (or pasted link) this is, and use it. */
  pair(text: string): Promise<void>
  /** Use another paired computer. */
  switchTo(key: string): Promise<void>
  /** Forget a computer (default: the one in use). */
  unpair(key?: string): Promise<void>
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
/** The dial in progress, so a switch can wait for it to let go. */
let inflight: Promise<void> | null = null
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
const removedListeners = new Set<(key: string) => void>()

/**
 * Runs when the computer in use changes or its pairing ends: everything
 * learned from that computer leaves memory.
 */
export function onUnpair(listener: () => void): () => void {
  unpairListeners.add(listener)
  return () => unpairListeners.delete(listener)
}

/** Runs when a computer is forgotten: what was kept on disk for it can go. */
export function onComputerRemoved(listener: (key: string) => void): () => void {
  removedListeners.add(listener)
  return () => removedListeners.delete(listener)
}

function forget(): void {
  subscribedChats = []
  for (const listener of unpairListeners) {
    listener()
  }
}

function removed(key: string): void {
  for (const listener of removedListeners) {
    listener(key)
  }
}

/** Store the list (and which one is in use) and publish it. */
function storeComputers(list: StoredPairing[], active: StoredPairing | null): void {
  useConnection.setState({ computers: list })
  void saveComputers({ list, active: active?.key ?? null }).catch(() => {})
}

/** Hang up on the computer in use and drop what was learned from it. */
async function detach(): Promise<void> {
  clearRetry()
  const current = client
  client = null
  current?.close()
  forget()
  await inflight?.catch(() => {})
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
function connect(token?: string, candidate?: StoredPairing): Promise<void> {
  if (connecting) {
    return candidate
      ? Promise.reject(new Error('Already connecting. Try again in a moment.'))
      : Promise.resolve()
  }
  const run = dial(token, candidate)
  inflight = run
  void run
    .catch(() => {})
    .finally(() => {
      if (inflight === run) {
        inflight = null
      }
    })
  return run
}

async function dial(token?: string, candidate?: StoredPairing): Promise<void> {
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
      lastHost: result.host,
      kind: result.server.kind ?? 'desktop'
    }
    const { computers } = useConnection.getState()
    if (
      !candidate &&
      (updated.lastHost !== pairing.lastHost ||
        updated.name !== pairing.name ||
        updated.kind !== pairing.kind ||
        known.join() !== pairing.hosts.join())
    ) {
      // A candidate is stored by pair() once it is accepted.
      storeComputers(
        computers.map((c) => (c.key === updated.key ? updated : c)),
        updated
      )
    }
    useConnection.setState({ phase: 'online', server: result.server, pairing: updated, error: null })
    if (subscribedChats.length > 0) {
      next.subscribe(subscribedChats)
    }
    for (const listener of onlineListeners) {
      listener()
    }
  } catch (error) {
    // Hung up on (a switch or a new pairing took over): not this dial's news.
    const superseded = client !== next
    if (!superseded) {
      client = null
    }
    next.close()
    const unreachable =
      'Cannot reach the computer. Check that Pi Desktop is open with remote control on (or pi-remote is running on the server), and that this phone can reach it.'
    if (candidate) {
      const message =
        error instanceof RemoteDeniedError
          ? 'That code no longer works. Show a new one on the computer and scan again.'
          : unreachable
      useConnection.setState({ error: message })
      throw new Error(message)
    }
    if (superseded) {
      return
    }
    if (error instanceof RemoteDeniedError) {
      // Removed on the computer: that pairing is over. Another paired
      // computer, if there is one, takes over.
      const { computers } = useConnection.getState()
      const rest = computers.filter((c) => c.key !== pairing.key)
      const fallback = rest[0] ?? null
      forget()
      removed(pairing.key)
      storeComputers(rest, fallback)
      useConnection.setState({
        phase: fallback ? 'connecting' : 'unpaired',
        pairing: fallback,
        server: null,
        error: `${pairing.name} removed this phone. Pair it again to use it.`
      })
      if (fallback) {
        attempt = 0
        queueMicrotask(() => void connect().catch(() => {}))
      }
      throw error
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
  computers: [],
  server: null,
  error: null,

  async init() {
    identity = await loadIdentity()
    const { list, active } = await loadComputers()
    const pairing = list.find((c) => c.key === active) ?? null
    if (!pairing) {
      set({ phase: 'unpaired', computers: list })
      return
    }
    set({ pairing, computers: list, phase: 'connecting' })
    void connect().catch(() => {})
  },

  async pair(text) {
    const payload = parsePairingPayload(text)
    if (!payload) {
      throw new Error('That is not a Pi Desktop pairing code')
    }
    identity ??= await loadIdentity()
    const { computers } = get()
    const known = computers.some((c) => c.key === payload.key)
    if (!known && computers.length >= MAX_COMPUTERS) {
      throw new Error(`Pi Remote keeps up to ${MAX_COMPUTERS} computers. Remove one in Settings first.`)
    }
    const candidate: StoredPairing = {
      key: payload.key,
      port: payload.port,
      hosts: payload.hosts,
      name: payload.name
    }
    // The computer in use (if any) steps aside while the new one answers,
    // and comes back if it does not.
    const previous = get().pairing
    if (previous) {
      await detach()
      set({ phase: 'connecting', server: null })
    }
    set({ error: null })
    try {
      await connect(payload.token, candidate)
    } catch (error) {
      if (previous) {
        const message = get().error
        set({ pairing: previous, phase: 'connecting', error: null })
        attempt = 0
        void connect()
          .catch(() => {})
          .finally(() => {
            // The phone is back on the old computer; the failure is what to show.
            if (message && get().phase === 'online') {
              set({ error: message })
            }
          })
      }
      throw error
    }
    const added = get().pairing!
    storeComputers([added, ...computers.filter((c) => c.key !== added.key)], added)
  },

  async switchTo(key) {
    const target = get().computers.find((c) => c.key === key)
    if (!target || get().pairing?.key === key) {
      return
    }
    await detach()
    storeComputers(get().computers, target)
    set({ pairing: target, server: null, phase: 'connecting', error: null })
    attempt = 0
    void connect().catch(() => {})
  },

  async unpair(key) {
    const { computers, pairing } = get()
    const gone = key ?? pairing?.key
    if (!gone) {
      return
    }
    const rest = computers.filter((c) => c.key !== gone)
    removed(gone)
    if (gone !== pairing?.key) {
      storeComputers(rest, pairing)
      return
    }
    await detach()
    const next = rest[0] ?? null
    storeComputers(rest, next)
    set({ phase: next ? 'connecting' : 'unpaired', pairing: next, server: null, error: null })
    if (next) {
      attempt = 0
      void connect().catch(() => {})
    }
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
    storeComputers(
      get().computers.map((c) => (c.key === updated.key ? updated : c)),
      updated
    )
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
