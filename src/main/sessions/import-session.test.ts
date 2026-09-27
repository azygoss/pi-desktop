import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { importSessionFile, sessionDirName } from './import-session'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-desktop-import-'))
  process.env['PI_CODING_AGENT_SESSION_DIR'] = join(dir, 'sessions')
})

afterEach(async () => {
  delete process.env['PI_CODING_AGENT_SESSION_DIR']
  await rm(dir, { recursive: true, force: true })
})

describe('sessionDirName', () => {
  it('encodes cwd the way pi names session dirs', () => {
    expect(sessionDirName('/Users/example/proj')).toBe('--Users-example-proj--')
    expect(sessionDirName('/')).toBe('----')
    expect(sessionDirName('C:\\work\\proj')).toBe('--C--work-proj--')
  })
})

describe('importSessionFile', () => {
  async function writeSession(cwd: string, name = 'in.jsonl'): Promise<string> {
    const path = join(dir, name)
    await writeFile(
      path,
      JSON.stringify({ type: 'session', version: 3, id: 'x', timestamp: '2024-01-01', cwd }) +
        '\n'
    )
    return path
  }

  it('copies a session into the dir matching its header cwd', async () => {
    const source = await writeSession('/Users/example/proj')
    const { sessionPath } = await importSessionFile(source)
    expect(sessionPath).toBe(
      join(dir, 'sessions', '--Users-example-proj--', 'in.jsonl')
    )
    expect(await readFile(sessionPath, 'utf8')).toContain('"cwd":"/Users/example/proj"')
  })

  it('never overwrites an existing import', async () => {
    const source = await writeSession('/Users/example/proj')
    const first = await importSessionFile(source)
    const second = await importSessionFile(source)
    expect(first.sessionPath).not.toBe(second.sessionPath)
    expect(second.sessionPath).toContain('in-1.jsonl')
  })

  it('rejects non-session files', async () => {
    const bad = join(dir, 'bad.jsonl')
    await writeFile(bad, '{"type":"other"}\n')
    await expect(importSessionFile(bad)).rejects.toThrow('header cwd')
    await expect(importSessionFile(join(dir, 'nope.txt'))).rejects.toThrow()
  })
})
