import * as SecureStore from 'expo-secure-store'

import {
  fromBase64Url,
  generateKeyPair,
  keyPairFromSecret,
  toBase64Url,
  type KeyPair
} from '../desktop'

/** The computer this phone is paired with. Lives in the Android Keystore. */
export interface StoredPairing {
  /** Desktop's static public key (base64url). */
  key: string
  port: number
  hosts: string[]
  name: string
  /** The address that worked last; tried first next time. */
  lastHost?: string
}

const IDENTITY_KEY = 'pi-remote.identity'
const PAIRING_KEY = 'pi-remote.pairing'

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

export async function loadPairing(): Promise<StoredPairing | null> {
  try {
    const raw = await SecureStore.getItemAsync(PAIRING_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<StoredPairing>) : null
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
        ...(typeof parsed.lastHost === 'string' ? { lastHost: parsed.lastHost } : {})
      }
    }
  } catch {
    // treated as not paired
  }
  return null
}

export async function savePairing(pairing: StoredPairing | null): Promise<void> {
  if (pairing) {
    await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(pairing))
  } else {
    await SecureStore.deleteItemAsync(PAIRING_KEY)
  }
}
