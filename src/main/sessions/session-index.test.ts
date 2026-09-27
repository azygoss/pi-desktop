import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearSessionIndexCache,
  listProjects,
  listSessions,
  watchSessions
} from './session-index'

let agentDir: string
let sessionsDir: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'pi-desktop-test-'))
  sessionsDir = join(agentDir, 'sessions')
  env = { PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionsDir }
  clearSessionIndexCache()
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

async function writeSession(projectDir: string, fileName: string, lines: object[]): Promise<string> {
  const dir = join(sessionsDir, projectDir)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, fileName)
  await writeFile(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return filePath
}

const HEADER = {
  type: 'session',
  version: 3,
  id: 'sess-0001',
  timestamp: '2026-01-01T10:00:00.000Z',
  cwd: '/Users/example/project-a'
}

describe('listSessions', () => {
  it('returns empty when the sessions dir does not exist', async () => {
    expect(await listSessions(env)).toEqual([])
  })

  it('parses header, counts messages and uses latest session_info name', async () => {
    await writeSession('--Users-example-project-a--', 's1.jsonl', [
      HEADER,
      { type: 'message', id: 'a1', parentId: null, message: { role: 'user', content: 'hi' } },
      {
        type: 'message',
        id: 'a2',
        parentId: 'a1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hey' }] }
      },
      { type: 'session_info', id: 'i1', parentId: 'a2', name: 'Old name' },
      { type: 'session_info', id: 'i2', parentId: 'i1', name: 'Renamed session' }
    ])
    const sessions = await listSessions(env)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: 'sess-0001',
      cwd: '/Users/example/project-a',
      name: 'Renamed session',
      title: 'Renamed session',
      created: '2026-01-01T10:00:00.000Z',
      messageCount: 2
    })
  })

  it('derives title from the first user message (string content)', async () => {
    await writeSession('p', 's.jsonl', [
      HEADER,
      {
        type: 'message',
        id: 'a1',
        parentId: null,
        message: { role: 'user', content: '  fix   the\nflaky   test  ' }
      }
    ])
    const sessions = await listSessions(env)
    expect(sessions[0]!.title).toBe('fix the flaky test')
  })

  it('derives title from the first user message (content array)', async () => {
    await writeSession('p', 's.jsonl', [
      HEADER,
      {
        type: 'message',
        id: 'a1',
        parentId: null,
        message: {
          role: 'user',
          content: [
            { type: 'image', data: 'xx', mimeType: 'image/png' },
            { type: 'text', text: 'array content title' }
          ]
        }
      }
    ])
    const sessions = await listSessions(env)
    expect(sessions[0]!.title).toBe('array content title')
  })

  it('strips <skill> prefixes from titles derived from user messages', async () => {
    await writeSession('p', 's.jsonl', [
      HEADER,
      {
        type: 'message',
        id: 'a1',
        parentId: null,
        message: {
          role: 'user',
          content:
            '<skill name="build-ios" location="/Users/example/.pi/skills/build-ios/SKILL.md">instructions</skill> ship the app'
        }
      },
      {
        type: 'message',
        id: 'a2',
        parentId: 'a1',
        message: {
          role: 'user',
          content:
            '<skill name="lone" location="/x">only an invocation</skill>'
        }
      }
    ])
    const sessions = await listSessions(env)
    // First user message wins; its typed remainder is the title.
    expect(sessions[0]!.title).toBe('ship the app')
  })

  it('titles skill-only first messages as /skill:name', async () => {
    await writeSession('p', 's.jsonl', [
      HEADER,
      {
        type: 'message',
        id: 'a1',
        parentId: null,
        message: {
          role: 'user',
          content: '<skill name="lone" location="/x">only an invocation</skill>'
        }
      }
    ])
    const sessions = await listSessions(env)
    expect(sessions[0]!.title).toBe('/skill:lone')
  })

  it('truncates long titles at 80 chars', async () => {
    await writeSession('p', 's.jsonl', [
      HEADER,
      { type: 'message', id: 'a1', parentId: null, message: { role: 'user', content: 'x'.repeat(200) } }
    ])
    const sessions = await listSessions(env)
    expect(sessions[0]!.title).toHaveLength(80)
    expect(sessions[0]!.title.endsWith('…')).toBe(true)
  })

  it('falls back to Untitled and tolerates malformed lines and old versions', async () => {
    const dir = join(sessionsDir, 'p')
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, 's.jsonl')
    const lines = [
      '{"type":"session","id":"old-1","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/Users/example/legacy"}',
      'this is { not json',
      '{"type":"message","id":"m1","parentId":null,"message":{"role":"assistant","content":[]}}',
      '42'
    ]
    await writeFile(filePath, lines.join('\n') + '\n')
    const sessions = await listSessions(env)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: 'old-1',
      cwd: '/Users/example/legacy',
      title: 'Untitled',
      messageCount: 1
    })
  })

  it('exposes parentSessionPath from the header', async () => {
    await writeSession('p', 's.jsonl', [
      { ...HEADER, parentSession: '/Users/example/.pi/agent/sessions/p/parent.jsonl' }
    ])
    const sessions = await listSessions(env)
    expect(sessions[0]!.parentSessionPath).toBe(
      '/Users/example/.pi/agent/sessions/p/parent.jsonl'
    )
  })

  it('sorts by modified descending', async () => {
    const a = await writeSession('p', 'a.jsonl', [{ ...HEADER, id: 'a' }])
    const b = await writeSession('p', 'b.jsonl', [{ ...HEADER, id: 'b' }])
    await utimes(a, new Date('2026-01-01'), new Date('2026-01-01'))
    await utimes(b, new Date('2026-02-01'), new Date('2026-02-01'))
    const sessions = await listSessions(env)
    expect(sessions.map((s) => s.id)).toEqual(['b', 'a'])
  })

  it('serves cached summaries for unchanged files', async () => {
    const filePath = await writeSession('p', 's.jsonl', [
      HEADER,
      { type: 'message', id: 'a1', parentId: null, message: { role: 'user', content: 'first title' } }
    ])
    const fixed = new Date('2026-01-02T00:00:00.000Z')
    await utimes(filePath, fixed, fixed)
    const first = await listSessions(env)
    expect(first[0]!.title).toBe('first title')

    // Rewrite with a different title but identical size and mtime: cache must hit.
    const replacement = [
      HEADER,
      { type: 'message', id: 'a1', parentId: null, message: { role: 'user', content: 'other title' } }
    ]
    await writeFile(filePath, replacement.map((l) => JSON.stringify(l)).join('\n') + '\n')
    await utimes(filePath, fixed, fixed)
    const second = await listSessions(env)
    expect(second[0]!.title).toBe('first title')
  })
})

describe('listProjects', () => {
  it('groups by cwd, names by basename, sorted by lastModified', async () => {
    const a = await writeSession('a', 's1.jsonl', [
      { ...HEADER, id: 'a', cwd: '/Users/example/alpha' }
    ])
    const b = await writeSession('b', 's2.jsonl', [
      { ...HEADER, id: 'b', cwd: '/Users/example/beta' }
    ])
    const b2 = await writeSession('b', 's3.jsonl', [
      { ...HEADER, id: 'b2', cwd: '/Users/example/beta' }
    ])
    await utimes(a, new Date('2026-01-01'), new Date('2026-01-01'))
    await utimes(b, new Date('2026-03-01'), new Date('2026-03-01'))
    await utimes(b2, new Date('2026-02-01'), new Date('2026-02-01'))

    const projects = listProjects(await listSessions(env))
    expect(projects).toHaveLength(2)
    expect(projects[0]).toMatchObject({ cwd: '/Users/example/beta', name: 'beta', sessionCount: 2 })
    expect(projects[1]).toMatchObject({ cwd: '/Users/example/alpha', name: 'alpha', sessionCount: 1 })
  })

  it('groups sessions without cwd under Other', async () => {
    await writeSession('p', 's.jsonl', [{ type: 'session', id: 'x', timestamp: '2026-01-01T00:00:00.000Z' }])
    const projects = listProjects(await listSessions(env))
    expect(projects).toEqual([
      expect.objectContaining({ cwd: '', name: 'Other', sessionCount: 1 })
    ])
  })
})

describe('watchSessions', () => {
  it('notifies on new session files (debounced)', async () => {
    await mkdir(sessionsDir, { recursive: true })
    let calls = 0
    const unwatch = watchSessions(() => {
      calls += 1
    }, env)
    try {
      await writeSession('p', 's.jsonl', [HEADER])
      await expect.poll(() => calls, { timeout: 10_000 }).toBeGreaterThan(0)
    } finally {
      unwatch()
    }
  }, 15_000)

  it('does not throw when the sessions dir is missing', async () => {
    const unwatch = watchSessions(() => {}, env)
    unwatch()
  })
})
