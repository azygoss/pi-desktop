import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PiProcessPool } from '../pi/pool'
import type { LocatorDeps } from '../pi/locator'
import {
  ChatService,
  startupHintFromStderr,
  type EvictionOptions
} from './chat-service'
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

function makeService(eviction: EvictionOptions = {}) {
  const broadcasts: { channel: string; payload: unknown }[] = []
  const pool = new PiProcessPool({ preferBundled: true, deps: fakeDeps() })
  const service = new ChatService(
    pool,
    (channel, payload) => {
      broadcasts.push({ channel, payload })
    },
    undefined,
    { sweepIntervalMs: 3_600_000, ...eviction }
  )
  return { service, broadcasts, pool }
}

let sessionsRoot: string
let userDataRoot: string

beforeEach(async () => {
  sessionsRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-chat-'))
  userDataRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-ud-'))
  process.env['PI_CODING_AGENT_SESSION_DIR'] = sessionsRoot
  // Points the scratch workspace dir at a temp dir without needing Electron.
  process.env['PI_DESKTOP_USER_DATA_DIR'] = userDataRoot
})

afterEach(async () => {
  delete process.env['PI_CODING_AGENT_SESSION_DIR']
  delete process.env['PI_DESKTOP_USER_DATA_DIR']
  await rm(sessionsRoot, { recursive: true, force: true })
  await rm(userDataRoot, { recursive: true, force: true })
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

describe('startupHintFromStderr', () => {
  it('names a retrying MCP server', () => {
    expect(startupHintFromStderr('[pi-mcp] Retrying "xcodebuildmcp" in 1000ms')).toBe(
      'waiting on MCP server “xcodebuildmcp”'
    )
    expect(startupHintFromStderr('[pi-mcp] Server "x" failed after 3 retries')).toBe(
      'MCP server “x” failed to start'
    )
    expect(startupHintFromStderr('ordinary noise')).toBeUndefined()
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

  it('creates the scratch workspace dir on demand for project-less chats', async () => {
    const { service, pool } = makeService()
    const scratch = join(userDataRoot, 'workspace')
    try {
      const result = await service.open({ chatId: 'chat-scratch', cwd: scratch })
      expect(result.cwd).toBe(scratch)
      expect((await stat(scratch)).isDirectory()).toBe(true)
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

  it('queues a send issued while open() is still in flight', async () => {
    const { service, broadcasts, pool } = makeService()
    try {
      const openPromise = service.open({ chatId: 'chat-q', cwd: tmpdir() })
      // Sent before open() has even created the record — must wait for it.
      const sendPromise = service.send({
        chatId: 'chat-q',
        message: 'queued hello',
        mode: 'prompt'
      })
      await openPromise
      await sendPromise
      await expect
        .poll(
          () =>
            broadcasts.some(
              (b) =>
                b.channel === 'pi-desktop:chat:event' &&
                (b.payload as { events?: { type?: string }[] }).events?.some(
                  (e) => e.type === 'agent_start'
                )
            ),
          { timeout: 5000 }
        )
        .toBe(true)
    } finally {
      await pool.closeAll()
    }
  })

  it('broadcasts chat:ready with the live catalog', async () => {
    const { service, broadcasts, pool } = makeService()
    try {
      await service.open({ chatId: 'chat-r', cwd: tmpdir() })
      const ready = broadcasts.find((b) => b.channel === 'pi-desktop:chat:ready')
      expect(ready).toBeTruthy()
      const payload = ready!.payload as { chatId: string; models: unknown[]; startupMs: number }
      expect(payload.chatId).toBe('chat-r')
      expect(payload.models.length).toBeGreaterThan(0)
      expect(payload.startupMs).toBeGreaterThanOrEqual(0)
    } finally {
      await pool.closeAll()
    }
  })

  it('adopts the warm spare for a project-less chat and respawns it', async () => {
    const { service, pool } = makeService()
    try {
      await service.warmSpare()
      expect(pool.get('__spare__')?.isRunning).toBe(true)
      const scratch = join(userDataRoot, 'workspace')
      const result = await service.open({ chatId: 'chat-adopt', cwd: scratch })
      expect(result.cwd).toBe(scratch)
      expect(pool.get('chat-adopt')?.isRunning).toBe(true)
      // The spare process itself now answers under the adopted chat id.
      await expect
        .poll(() => pool.get('__spare__') !== undefined, { timeout: 5000 })
        .toBe(true)
    } finally {
      await pool.closeAll()
    }
  })

  it('drops warm spares when the computer-use flag flips and rewarms with new env', async () => {
    const pool = new PiProcessPool({ preferBundled: true, deps: fakeDeps() })
    let cuaOn = true
    const bridge = {
      url: () => 'http://127.0.0.1:9',
      issue: () => 'tok',
      revoke: () => {},
      adopt: () => {},
      extensionPath: () => '',
      computerToolsEnabled: () => cuaOn
    }
    const service = new ChatService(pool, () => {}, bridge, {
      sweepIntervalMs: 3_600_000
    })
    try {
      const envs: (Record<string, string> | undefined)[] = []
      const origOpen = pool.open.bind(pool)
      vi.spyOn(pool, 'open').mockImplementation((id, opts) => {
        envs.push(opts.extraEnv)
        return origOpen(id, opts)
      })
      await service.warmSpare()
      expect(pool.get('__spare__')?.isRunning).toBe(true)
      expect(envs.at(-1)?.['PI_DESKTOP_COMPUTER_USE']).toBe('1')
      const staleSpare = pool.get('__spare__')
      cuaOn = false
      await service.resetSpares()
      // The stale spare is dropped; a fresh one warms with the new flag.
      await expect
        .poll(() => envs.length >= 2 && pool.get('__spare__') !== undefined, {
          timeout: 5000
        })
        .toBe(true)
      expect(envs.at(-1)?.['PI_DESKTOP_COMPUTER_USE']).toBeUndefined()
      expect(pool.get('__spare__')).not.toBe(staleSpare)
    } finally {
      await pool.closeAll()
    }
  })

  it('evicts idle chats beyond the cap, keeps the focused one, revives on send', async () => {
    const { service, pool } = makeService({ maxIdleProcesses: 1 })
    try {
      await service.open({ chatId: 'e1', cwd: tmpdir() })
      await new Promise((r) => setTimeout(r, 10))
      await service.open({ chatId: 'e2', cwd: tmpdir() })
      await new Promise((r) => setTimeout(r, 10))
      await service.open({ chatId: 'e3', cwd: tmpdir() })
      service.markFocused('e3')
      await service.sweepEvictions()
      // Cap is 1 for idle processes; e3 is focused (doesn't count). e1 is
      // the oldest idle chat → evicted; e2 survives.
      expect(service.isEvicted('e1')).toBe(true)
      expect(service.hasProcess('e1')).toBe(false)
      expect(service.hasProcess('e2')).toBe(true)
      expect(service.hasProcess('e3')).toBe(true)
      // A send to the evicted chat transparently respawns its process.
      await service.send({ chatId: 'e1', message: 'back again', mode: 'prompt' })
      expect(service.hasProcess('e1')).toBe(true)
      expect(service.isEvicted('e1')).toBe(false)
    } finally {
      await pool.closeAll()
    }
  })

  it('lets a second device join an open chat instead of starting another pi', async () => {
    const { service, broadcasts, pool } = makeService({ maxIdleProcesses: 0 })
    try {
      const first = await service.open({ chatId: 'j1', cwd: tmpdir() })
      const ready = () => broadcasts.filter((b) => b.channel === 'pi-desktop:chat:ready').length
      expect(ready()).toBe(1)
      const client = pool.get('j1')
      // The window (or a paired phone) opening the same chat again joins it.
      const joined = await service.open({ chatId: 'j1', cwd: tmpdir() })
      expect(joined.models).toEqual(first.models)
      expect(pool.get('j1')).toBe(client)
      expect(ready()).toBe(1)
      expect(service.listLive()).toMatchObject([{ chatId: 'j1', streaming: false }])

      const sessionPath = first.sessionPath
      if (sessionPath) {
        expect(service.chatIdForSession(sessionPath)).toBe('j1')
        // Its idle process is stopped: the session still belongs to that chat.
        await service.sweepEvictions()
        expect(service.isEvicted('j1')).toBe(true)
        expect(service.chatIdForSession(sessionPath)).toBe('j1')
        expect(service.listLive()).toEqual([])
      }
    } finally {
      await pool.closeAll()
    }
  })

  it('counts a chat a paired phone used as recently viewed', async () => {
    const { service, pool } = makeService({ maxIdleProcesses: 1 })
    try {
      await service.open({ chatId: 't1', cwd: tmpdir() })
      await new Promise((r) => setTimeout(r, 10))
      await service.open({ chatId: 't2', cwd: tmpdir() })
      await new Promise((r) => setTimeout(r, 10))
      service.touch('t1')
      await service.sweepEvictions()
      expect(service.hasProcess('t1')).toBe(true)
      expect(service.isEvicted('t2')).toBe(true)
    } finally {
      await pool.closeAll()
    }
  })

  it('announces an answered extension dialog to every device', async () => {
    const { service, broadcasts, pool } = makeService()
    try {
      await service.open({ chatId: 'u1', cwd: tmpdir() })
      await service.respondUi({ chatId: 'u1', id: 'dialog-1', confirmed: true })
      expect(broadcasts).toContainEqual({
        channel: 'pi-desktop:chat:ui-resolved',
        payload: { chatId: 'u1', id: 'dialog-1' }
      })
    } finally {
      await pool.closeAll()
    }
  })

  it('evicts chats not viewed within the idle window', async () => {
    const { service, pool } = makeService({ idleEvictMs: 0 })
    try {
      await service.open({ chatId: 'stale', cwd: tmpdir() })
      service.markFocused('stale')
      // Focus moves elsewhere: 'stale' is now idle AND unviewed (0ms window).
      await service.open({ chatId: 'other', cwd: tmpdir() })
      service.markFocused('other')
      await new Promise((r) => setTimeout(r, 5)) // cross the 0ms window
      await service.sweepEvictions()
      expect(service.isEvicted('stale')).toBe(true)
      expect(service.hasProcess('other')).toBe(true)
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

  it('adopts a project warm spare warmed via warmCwd', async () => {
    const { service, pool } = makeService()
    try {
      await service.warmCwd({ cwd: tmpdir() })
      expect(service.hasWarmSpare(tmpdir())).toBe(true)
      const result = await service.open({ chatId: 'chat-warm', cwd: tmpdir() })
      expect(result.cwd).toBe(tmpdir())
      // The spare was adopted, not left running alongside the chat.
      expect(service.hasWarmSpare(tmpdir())).toBe(false)
      expect(service.hasProcess('chat-warm')).toBe(true)
    } finally {
      await pool.closeAll()
    }
  })

  function warmClient(pool: PiProcessPool) {
    return [...Array(10).keys()]
      .map((i) => pool.get(`__warm__${i}`))
      .find((client) => client !== undefined)
  }

  async function writeSession(name: string): Promise<string> {
    const dir = join(sessionsRoot, 'proj')
    await mkdir(dir, { recursive: true })
    const sessionPath = join(dir, `${name}.jsonl`)
    const lines = [
      { type: 'session', cwd: tmpdir() },
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        message: { role: 'user', content: 'synthetic past prompt', timestamp: 1 }
      }
    ]
    await writeFile(sessionPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return sessionPath
  }

  it('loads a past session into the warm spare via switch_session', async () => {
    const { service, pool } = makeService()
    try {
      const sessionPath = await writeSession('switch')
      await service.warmCwd({ cwd: tmpdir() })
      const spare = warmClient(pool)
      expect(spare?.isRunning).toBe(true)
      const result = await service.open({ chatId: 'chat-switch', sessionPath })
      expect(result.cwd).toBe(tmpdir())
      expect(result.sessionPath).toBe(sessionPath)
      expect(result.messages).toHaveLength(1)
      // The spare itself now serves the session — no second process.
      expect(pool.get('chat-switch')).toBe(spare)
      expect(service.hasWarmSpare(tmpdir())).toBe(false)
    } finally {
      await pool.closeAll()
    }
  })

  it('falls back to spawning pi --session when the switch is cancelled', async () => {
    const { service, pool } = makeService()
    process.env['PI_FAKE_PI_SWITCH_CANCEL'] = '1'
    try {
      const sessionPath = await writeSession('cancel')
      await service.warmCwd({ cwd: tmpdir() })
      const spare = warmClient(pool)
      expect(spare?.isRunning).toBe(true)
      const result = await service.open({ chatId: 'chat-cancel', sessionPath })
      // Messages come from the fresh `--session` spawn, not the vetoed spare.
      expect(result.messages).toHaveLength(1)
      expect(pool.get('chat-cancel')).not.toBe(spare)
      await expect.poll(() => spare?.isRunning, { timeout: 5000 }).toBe(false)
    } finally {
      delete process.env['PI_FAKE_PI_SWITCH_CANCEL']
      await pool.closeAll()
    }
  })

  it('parks an unprompted chat process on setCwd and reuses it on return', async () => {
    const { service, pool } = makeService()
    try {
      const dirA = await mkdtemp(join(tmpdir(), 'pi-park-a-'))
      const dirB = await mkdtemp(join(tmpdir(), 'pi-park-b-'))
      await service.open({ chatId: 'chat-swp', cwd: dirA })
      const first = pool.get('chat-swp')
      await service.setCwd({ chatId: 'chat-swp', cwd: dirB })
      // The untouched dirA process was parked as a spare instead of killed.
      expect(service.hasWarmSpare(dirA)).toBe(true)
      expect(pool.get('chat-swp')).not.toBe(first)
      // Switching back adopts the parked process — no cold restart.
      await service.setCwd({ chatId: 'chat-swp', cwd: dirA })
      expect(pool.get('chat-swp')).toBe(first)
      expect(service.hasWarmSpare(dirA)).toBe(false)
    } finally {
      await pool.closeAll()
    }
  })

  it('does not park a prompted chat on setCwd', async () => {
    const { service, pool } = makeService()
    try {
      const dirA = await mkdtemp(join(tmpdir(), 'pi-park-c-'))
      const dirB = await mkdtemp(join(tmpdir(), 'pi-park-d-'))
      await service.open({ chatId: 'chat-sent', cwd: dirA })
      await service.send({ chatId: 'chat-sent', message: 'hi', mode: 'prompt' })
      await service.setCwd({ chatId: 'chat-sent', cwd: dirB })
      expect(service.hasWarmSpare(dirA)).toBe(false)
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
