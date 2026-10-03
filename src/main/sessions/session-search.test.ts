import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { searchSessions, snippetAround } from './session-search'

async function session(dir: string, name: string, messages: unknown[]): Promise<string> {
  const file = join(dir, `${name}.jsonl`)
  const lines = [
    { type: 'session', version: 3, id: name, timestamp: '2026-01-01T00:00:00Z', cwd: '/x' },
    ...messages.map((message, i) => ({ type: 'message', id: `${name}-${i}`, message }))
  ]
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}

describe('searchSessions', () => {
  it('finds text in prompts and replies, case-insensitively', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-search-'))
    const a = await session(dir, 'a', [
      { role: 'user', content: 'Refactor the Session Index watcher' },
      { role: 'assistant', content: [{ type: 'text', text: 'The session index is cached.' }] }
    ])
    const b = await session(dir, 'b', [{ role: 'user', content: 'unrelated prompt' }])
    const hits = await searchSessions([a, b], 'session index')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ sessionPath: a, role: 'user', matches: 2 })
    expect(hits[0]!.snippet).toContain('Session Index')
  })

  it('ignores tool output and matches text with quotes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-search-'))
    const a = await session(dir, 'a', [
      { role: 'toolResult', content: [{ type: 'text', text: 'needle in tool output' }] },
      { role: 'user', content: 'say "hello world" please' }
    ])
    expect(await searchSessions([a], 'needle in tool')).toEqual([])
    expect(await searchSessions([a], '"hello world"')).toHaveLength(1)
  })

  it('needs at least three characters and honors the limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-search-'))
    const files = await Promise.all(
      ['a', 'b', 'c'].map((n) => session(dir, n, [{ role: 'user', content: 'common words' }]))
    )
    expect(await searchSessions(files, 'co')).toEqual([])
    expect(await searchSessions(files, 'common', 2)).toHaveLength(2)
  })
})

describe('snippetAround', () => {
  it('collapses whitespace and marks cut ends', () => {
    const text = `${'a'.repeat(100)}\n\nfind   me here${'b'.repeat(200)}`
    const snippet = snippetAround(text, text.indexOf('find'), 4)
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet).toContain('find me here')
  })
})
