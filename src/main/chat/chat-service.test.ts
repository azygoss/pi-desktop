import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PiProcessPool } from '../pi/pool'
import type { LocatorDeps } from '../pi/locator'
import { ChatService } from './chat-service'
import {
  validateChatId,
  validateCwd,
  validateImages,
  validateMessage,
  validateSessionPath
} from './validation'

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../test/fixtures/fake-pi.mjs'
)

function fakeDeps(): Partial<LocatorDeps> {
  return {
    resolveBundledCli: async () => ({ cliPath: fixturePath, version: '0.0.0-test' }),
    readVersion: async () => '0.0.0-test',
    isExecutable: async () => false
  }
}

function makeService() {
  const broadcasts: { channel: string; payload: unknown }[] = []
  const pool = new PiProcessPool({ preferBundled: true, deps: fakeDeps() })
  const service = new ChatService(pool, (channel, payload) => {
    broadcasts.push({ channel, payload })
  })
  return { service, broadcasts, pool }
}

let sessionsRoot: string

beforeEach(async () => {
  sessionsRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-chat-'))
  process.env['PI_CODING_AGENT_SESSION_DIR'] = sessionsRoot
})

afterEach(async () => {
  delete process.env['PI_CODING_AGENT_SESSION_DIR']
  await rm(sessionsRoot, { recursive: true, force: true })
})

describe('validation', () => {
  it('accepts valid chat ids and rejects bad ones', () => {
    expect(validateChatId('abc-DEF_123')).toBe('abc-DEF_123')
    expect(() => validateChatId('has spaces')).toThrow()
    expect(() => validateChatId('x'.repeat(65))).toThrow()
    expect(() => validateChatId(42)).toThrow()
    expect(() => validateChatId('')).toThrow()
  })

  it('validates cwd: absolute existing dir or default', async () => {
    expect(await validateCwd(undefined)).toBeTruthy()
    expect(await validateCwd(tmpdir())).toBeTruthy()
    await expect(validateCwd('relative/path')).rejects.toThrow()
    await expect(validateCwd('/definitely/not/here-xyz')).rejects.toThrow()
  })

  it('restricts sessionPath to .jsonl inside the sessions dir', async () => {
    const inside = join(sessionsRoot, 'proj', 's.jsonl')
    expect(validateSessionPath(inside)).toBe(inside)
    expect(() => validateSessionPath('/tmp/elsewhere.jsonl')).toThrow()
    expect(() => validateSessionPath(join(sessionsRoot, 's.txt'))).toThrow()
    expect(() => validateSessionPath(join(sessionsRoot, '..', 'escape.jsonl'))).toThrow()
    expect(() => validateSessionPath(123)).toThrow()
  })

  it('validates images: mime allowlist, base64, size cap', () => {
    const img = { data: 'aGVsbG8=', mimeType: 'image/png' }
    expect(validateImages([img])).toEqual([{ type: 'image', ...img }])
    expect(validateImages(undefined)).toBeUndefined()
    expect(() => validateImages([{ data: 'x', mimeType: 'application/x-evil' }])).toThrow()
    expect(() => validateImages([{ data: '!!!', mimeType: 'image/png' }])).toThrow()
    expect(() =>
      validateImages([{ data: 'A'.repeat(28 * 1024 * 1024), mimeType: 'image/png' }])
    ).toThrow()
  })

  it('rejects empty or oversized messages', () => {
    expect(validateMessage('hello')).toBe('hello')
    expect(() => validateMessage('')).toThrow()
    expect(() => validateMessage('x'.repeat(200_001))).toThrow()
  })
})

describe('ChatService', () => {
  it('opens a chat and returns state, messages, models, commands', async () => {
    const { service, pool } = makeService()
    try {
      const result = await service.open({ chatId: 'chat-1', cwd: tmpdir() })
      expect(result.chatId).toBe('chat-1')
      expect(result.state).toMatchObject({ isStreaming: false })
      expect(result.models.length).toBeGreaterThan(0)
      expect(result.thinkingLevels).toContain('off')
      expect(result.messages).toEqual([])
    } finally {
      await pool.closeAll()
    }
  })

  it('forwards pi events and ui requests with chatId', async () => {
    const { service, broadcasts, pool } = makeService()
    try {
      await service.open({ chatId: 'chat-2', cwd: tmpdir() })
      await service.send({ chatId: 'chat-2', message: 'hi', mode: 'prompt' })
      await expect
        .poll(() => broadcasts.some((b) => b.channel === 'pi-desktop:chat:event'), {
          timeout: 5000
        })
        .toBe(true)
      const eventBroadcast = broadcasts.find((b) => b.channel === 'pi-desktop:chat:event')
      expect(eventBroadcast).toBeTruthy()
      expect((eventBroadcast!.payload as { chatId: string }).chatId).toBe('chat-2')
    } finally {
      await pool.closeAll()
    }
  })

  it('emits exit payload with stderrTail on process exit', async () => {
    const { service, broadcasts, pool } = makeService()
    try {
      await service.open({ chatId: 'chat-3', cwd: tmpdir() })
      const client = pool.get('chat-3')!
      client.sendRaw({ type: 'die' })
      await expect
        .poll(() => broadcasts.some((b) => b.channel === 'pi-desktop:chat:exit'), {
          timeout: 5000
        })
        .toBe(true)
      const exit = broadcasts.find((b) => b.channel === 'pi-desktop:chat:exit')!
      expect((exit.payload as { chatId: string; code: number }).chatId).toBe('chat-3')
    } finally {
      await pool.closeAll()
    }
  })

  it('send fails for unknown chat', async () => {
    const { service, pool } = makeService()
    try {
      await expect(
        service.send({ chatId: 'nope', message: 'x', mode: 'prompt' })
      ).rejects.toThrow('No running pi process')
    } finally {
      await pool.closeAll()
    }
  })

  it('renames a closed session via a short-lived process', async () => {
    const { service, pool } = makeService()
    try {
      const dir = join(sessionsRoot, 'proj')
      await mkdir(dir, { recursive: true })
      const sessionPath = join(dir, 's1.jsonl')
      await writeFile(
        sessionPath,
        JSON.stringify({ type: 'session', cwd: tmpdir() }) + '\n'
      )
      await service.renameSession({ sessionPath, name: 'Renamed chat' })
      // The short-lived process is closed; a second rename still works.
      await service.renameSession({ sessionPath, name: 'Renamed again' })
      expect(service.chatIdForSession(sessionPath)).toBeUndefined()
    } finally {
      await pool.closeAll()
    }
  })

  it('renames via the open chat process when the session is open', async () => {
    const { service, pool } = makeService()
    try {
      const dir = join(sessionsRoot, 'proj')
      await mkdir(dir, { recursive: true })
      const sessionPath = join(dir, 's2.jsonl')
      await writeFile(
        sessionPath,
        JSON.stringify({ type: 'session', cwd: tmpdir() }) + '\n'
      )
      await service.open({ chatId: 'chat-rn', sessionPath })
      expect(service.chatIdForSession(sessionPath)).toBe('chat-rn')
      await service.renameSession({ sessionPath, name: 'Open rename' })
      await expect(service.closeChatForSession(sessionPath)).resolves.toBe(true)
    } finally {
      await pool.closeAll()
    }
  })

  it('exports a session to html and forks/clones an open chat', async () => {
    const { service, pool } = makeService()
    try {
      const dir = join(sessionsRoot, 'proj')
      await mkdir(dir, { recursive: true })
      const sessionPath = join(dir, 's3.jsonl')
      await writeFile(
        sessionPath,
        JSON.stringify({ type: 'session', cwd: tmpdir() }) + '\n'
      )
      const out = join(sessionsRoot, 'export.html')
      const exported = await service.exportSession({ sessionPath, outputPath: out })
      expect(exported.path).toBe(out)

      await service.open({ chatId: 'chat-fk', sessionPath })
      const forkMessages = await service.getForkMessages({ chatId: 'chat-fk' })
      expect(forkMessages).toEqual({ messages: [] })
      const forked = await service.fork({ chatId: 'chat-fk', entryId: 'entry-0' })
      expect(forked.cancelled).toBe(false)
      const cloned = await service.clone({ chatId: 'chat-fk' })
      expect(cloned.cancelled).toBe(false)
    } finally {
      await pool.closeAll()
    }
  })

  it('rejects rename/export for paths outside the sessions dir', async () => {
    const { service, pool } = makeService()
    try {
      await expect(
        service.renameSession({ sessionPath: '/tmp/elsewhere.jsonl', name: 'x' })
      ).rejects.toThrow('sessions directory')
      await expect(
        service.exportSession({
          sessionPath: join(sessionsRoot, 's.jsonl'),
          outputPath: 'relative.html'
        })
      ).rejects.toThrow('absolute')
    } finally {
      await pool.closeAll()
    }
  })
})
