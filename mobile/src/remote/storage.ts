import * as SecureStore from 'expo-secure-store'

import {
  fromBase64Url,
  generateKeyPair,
  keyPairFromSecret,
  toBase64Url,
  type KeyPair
} from '../desktop'

/** A computer this phone is paired with. Lives in the Android Keystore. */
export interface StoredPairing {
  /** Desktop's static public key (base64url). */
  key: string
  port: number
  hosts: string[]
  name: string
  /** The address that worked last; tried first next time. */
  lastHost?: string
  /** Pi Desktop, or pi-remote on a server (learned on connecting). */
  kind?: 'desktop' | 'server'
}

const IDENTITY_KEY = 'pi-remote.identity'
const LEGACY_PAIRING_KEY = 'pi-remote.pairing'

/** This phone's long-term key pair, created on first launch. */
export async function loadIdentity(): Promise<KeyPair> {
  try {
    const stored = await SecureStore.getItemAsync(IDENTITY_KEY)
    if (stored) {
      return keyPairFromSecret(fromBase64Url(stored))
    }
  } catch {
    // unreadable entry: start over with a fresh identity (pairing is redone)
  }
  const identity = generateKeyPair()
  await SecureStore.setItemAsync(IDENTITY_KEY, toBase64Url(identity.secretKey))
  return identity
}

/** Every computer this phone is paired with, and the one in use. */
export interface StoredComputers {
  list: StoredPairing[]
  /** Key of the computer in use; null when none is paired. */
  active: string | null
}

/** Enough for a desk, a laptop and a few servers; keeps the entry small. */
export const MAX_COMPUTERS = 8

const COMPUTERS_KEY = 'pi-remote.computers'

function cleanPairing(value: unknown): StoredPairing | null {
  const parsed = value as Partial<StoredPairing> | null
  if (
    parsed &&
    typeof parsed.key === 'string' &&
    typeof parsed.port === 'number' &&
    Array.isArray(parsed.hosts) &&
    parsed.hosts.length > 0
  ) {
    return {
      key: parsed.key,
      port: parsed.port,
      hosts: parsed.hosts.filter((h): h is string => typeof h === 'string'),
      name: typeof parsed.name === 'string' ? parsed.name : 'Computer',
      ...(typeof parsed.lastHost === 'string' ? { lastHost: parsed.lastHost } : {}),
      ...(parsed.kind === 'desktop' || parsed.kind === 'server' ? { kind: parsed.kind } : {})
    }
  }
  return null
}

export async function loadComputers(): Promise<StoredComputers> {
  try {
    const raw = await SecureStore.getItemAsync(COMPUTERS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { list?: unknown; active?: unknown }
      const list = (Array.isArray(parsed.list) ? parsed.list : [])
        .map(cleanPairing)
        .filter((p): p is StoredPairing => p !== null)
        .slice(0, MAX_COMPUTERS)
      const active =
        typeof parsed.active === 'string' && list.some((p) => p.key === parsed.active)
          ? parsed.active
          : (list[0]?.key ?? null)
      return { list, active }
    }
    // Before several computers: one pairing under its own entry. Move it over.
    const legacyRaw = await SecureStore.getItemAsync(LEGACY_PAIRING_KEY)
    const legacy = legacyRaw ? cleanPairing(JSON.parse(legacyRaw)) : null
    const computers = { list: legacy ? [legacy] : [], active: legacy?.key ?? null }
    if (legacy) {
      await saveComputers(computers)
      await SecureStore.deleteItemAsync(LEGACY_PAIRING_KEY).catch(() => {})
    }
    return computers
  } catch {
    // treated as not paired
    return { list: [], active: null }
  }
}

export async function saveComputers(computers: StoredComputers): Promise<void> {
  if (computers.list.length === 0) {
    await SecureStore.deleteItemAsync(COMPUTERS_KEY)
    return
  }
  await SecureStore.setItemAsync(COMPUTERS_KEY, JSON.stringify(computers))
}
