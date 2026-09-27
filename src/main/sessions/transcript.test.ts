import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readSessionTranscript } from './transcript'
import type { AgentMessage } from '../../shared/pi-types'

function messageText(m: AgentMessage): string {
  if (m.role === 'user') {
    return typeof m.content === 'string' ? m.content : ''
  }
  if ('content' in m && Array.isArray(m.content)) {
    const textBlock = (m.content as { type: string; text?: string }[]).find(
      (b) => b.type === 'text'
    )
    return textBlock?.text ?? ''
  }
  return ''
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-desktop-transcript-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function user(id: string, parentId: string | null, text: string) {
  return {
    type: 'message',
    id,
    parentId,
    message: { role: 'user', content: text, timestamp: 1 }
  }
}

function assistant(id: string, parentId: string | null, text: string) {
  return {
    type: 'message',
    id,
    parentId,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      timestamp: 1
    }
  }
}

async function write(lines: unknown[]): Promise<string> {
  const path = join(dir, `s-${Math.random().toString(36).slice(2, 8)}.jsonl`)
  await writeFile(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  return path
}

describe('readSessionTranscript', () => {
  it('collects message entries in order', async () => {
    const path = await write([
      { type: 'session', id: 's', cwd: '/x', timestamp: '2025-01-01' },
      user('m1', null, 'hello'),
      assistant('m2', 'm1', 'hi there')
    ])
    const result = await readSessionTranscript(path)
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(result.hasEarlier).toBe(false)
    expect(result.totalMessages).toBe(2)
  })

  it('follows the active branch, ignoring forked-off entries', async () => {
    const path = await write([
      { type: 'session', id: 's', cwd: '/x' },
      user('m1', null, 'first'),
      assistant('m2', 'm1', 'answer one'),
      // A fork: branched off m1 but not on the active branch.
      user('b1', 'm1', 'forked question'),
      assistant('b2', 'b1', 'forked answer'),
      // Active branch continues from m2; the last entry decides the head.
      user('m3', 'm2', 'second'),
      assistant('m4', 'm3', 'answer two')
    ])
    const result = await readSessionTranscript(path)
    const texts = result.messages.map(messageText)
    expect(texts).toEqual(['first', 'answer one', 'second', 'answer two'])
  })

  it('when the last entry is on a fork, that branch is the transcript', async () => {
    const path = await write([
      { type: 'session', id: 's', cwd: '/x' },
      user('m1', null, 'first'),
      assistant('m2', 'm1', 'answer one'),
      // Fork created later — file tail belongs to the forked branch.
      user('b1', 'm1', 'edit the first message'),
      assistant('b2', 'b1', 'forked answer')
    ])
    const result = await readSessionTranscript(path)
    const texts = result.messages.map(messageText)
    expect(texts).toEqual(['first', 'edit the first message', 'forked answer'])
  })

  it('tolerates malformed lines and non-message entries', async () => {
    const path = await write([
      { type: 'session', id: 's', cwd: '/x' },
      'this is not json {{{',
      user('m1', null, 'hello'),
      { type: 'session_info', name: 'Named chat' },
      assistant('m2', 'm1', 'hi'),
      '{"type":"message","id":"broken'
    ])
    const result = await readSessionTranscript(path)
    expect(result.messages).toHaveLength(2)
  })

  it('skips entries without ids and stops at dangling parents', async () => {
    const path = await write([
      { type: 'session', id: 's', cwd: '/x' },
      { type: 'message', parentId: null, message: { role: 'user', content: 'orphan' } },
      user('m1', 'missing-parent', 'hello'),
      assistant('m2', 'm1', 'hi')
    ])
    const result = await readSessionTranscript(path)
    expect(result.messages).toHaveLength(2) // m2, m1 — walk stops at the gap
  })

  it('caps at the limit and reports hasEarlier', async () => {
    const lines: unknown[] = [{ type: 'session', id: 's', cwd: '/x' }]
    let parent: string | null = null
    for (let i = 0; i < 60; i++) {
      lines.push(user(`m${i}`, parent, `msg ${i}`))
      parent = `m${i}`
    }
    const path = await write(lines)
    const result = await readSessionTranscript(path, { limit: 50 })
    expect(result.messages).toHaveLength(50)
    expect(result.hasEarlier).toBe(true)
    expect(result.totalMessages).toBe(60)
    // The window is the *latest* entries.
    const last = result.messages[result.messages.length - 1]
    expect(last?.role === 'user' && last.content === 'msg 59').toBe(true)
    const first = result.messages[0]
    expect(first?.role === 'user' && first.content === 'msg 10').toBe(true)
  })

  it('returns empty for a missing file', async () => {
    const result = await readSessionTranscript(join(dir, 'nope.jsonl'))
    expect(result).toEqual({ messages: [], hasEarlier: false, totalMessages: 0 })
  })

  it('survives a parentId cycle', async () => {
    const path = await write([
      { type: 'session', id: 's', cwd: '/x' },
      user('m1', 'm2', 'loop a'),
      user('m2', 'm1', 'loop b')
    ])
    const result = await readSessionTranscript(path)
    expect(result.messages.length).toBeGreaterThan(0)
  })
})
