import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearSessionMetaCache,
  getSessionMeta,
  removeSessionMeta,
  setSessionMeta
} from './session-meta'

let userData: string
let sessionsDir: string

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'pi-desktop-meta-'))
  sessionsDir = join(userData, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  process.env['PI_DESKTOP_USER_DATA_DIR'] = userData
  clearSessionMetaCache()
})

afterEach(async () => {
  delete process.env['PI_DESKTOP_USER_DATA_DIR']
  clearSessionMetaCache()
  await rm(userData, { recursive: true, force: true })
})

async function writeSession(name: string): Promise<string> {
  const filePath = join(sessionsDir, name)
  await writeFile(filePath, '{"type":"session","id":"x"}\n')
  return filePath
}

describe('session-meta', () => {
  it('starts empty', async () => {
    expect(await getSessionMeta()).toEqual({})
  })

  it('sets and unsets pinned/archived', async () => {
    const path = await writeSession('a.jsonl')
    const map = await setSessionMeta(path, { pinned: true })
    expect(map[path]!.pinned).toBeTypeOf('number')
    const again = await setSessionMeta(path, { archived: true })
    expect(again[path]!.archived).toBeTypeOf('number')
    expect(again[path]!.pinned).toBeTypeOf('number')
    const cleared = await setSessionMeta(path, { pinned: false })
    expect(cleared[path]!.pinned).toBeUndefined()
    expect(cleared[path]!.archived).toBeTypeOf('number')
    // Unsetting the last flag drops the entry entirely.
    const empty = await setSessionMeta(path, { archived: false })
    expect(empty[path]).toBeUndefined()
  })

  it('persists atomically and reloads across cache resets', async () => {
    const path = await writeSession('b.jsonl')
    await setSessionMeta(path, { pinned: true })
    // The debounced write lands within ~200ms.
    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(join(userData, 'session-meta.json'), 'utf8'))
      expect(raw.entries[path].pinned).toBeTypeOf('number')
    })
    clearSessionMetaCache()
    const map = await getSessionMeta()
    expect(map[path]!.pinned).toBeTypeOf('number')
    // No stray tmp files behind the atomic rename.
    const leftovers = (await import('node:fs/promises')).readdir(userData)
    for (const name of await leftovers) {
      expect(name).not.toMatch(/\.tmp-/)
    }
  })

  it('prunes entries whose session file disappeared', async () => {
    const path = await writeSession('c.jsonl')
    await setSessionMeta(path, { pinned: true })
    await rm(path)
    clearSessionMetaCache()
    expect(await getSessionMeta()).toEqual({})
  })

  it('removes an entry on session delete', async () => {
    const path = await writeSession('d.jsonl')
    await setSessionMeta(path, { archived: true })
    await removeSessionMeta(path)
    expect(await getSessionMeta()).toEqual({})
  })
})
