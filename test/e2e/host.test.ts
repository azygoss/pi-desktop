// pi-remote, the headless host, end to end: the built CLI with the fake pi,
// a phone that pairs through `pi-remote pair`'s control socket, a chat run
// from the phone, an automation, and removing the phone with the CLI.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { callControl, controlSocketPath } from '../../src/host/control'
import type { RemoteStatus } from '../../src/main/remote/remote-server'
import { generateKeyPair } from '../../src/shared/remote/crypto'
import { parsePairingPayload, type ServerFrame } from '../../src/shared/remote/protocol'
import { TestPhone } from '../fixtures/remote-phone'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const FAKE_PI = join(ROOT, 'test/fixtures/fake-pi.mjs')
const CLI = join(ROOT, 'out/host/pi-remote.mjs')
const run = promisify(execFile)

type EventFrame = Extract<ServerFrame, { t: 'ev' }>
const isEvent = (f: ServerFrame): f is EventFrame => f.t === 'ev'

describe('pi-remote host', () => {
  let host: ChildProcess
  let output = ''
  let phone: TestPhone
  let socket: string
  let dataDir: string
  let env: NodeJS.ProcessEnv
  const dirs: string[] = []
  const port = 41000 + Math.floor(Math.random() * 2000)
  let nextId = 1

  async function call<T>(channel: string, arg?: unknown): Promise<T> {
    const res = await phone.request(nextId++, channel, arg)
    if (!res.ok) {
      throw new Error(res.e)
    }
    return res.d as T
  }

  async function waitFor(text: string, timeoutMs = 30_000): Promise<void> {
    const until = Date.now() + timeoutMs
    while (!output.includes(text)) {
      if (Date.now() > until || host.exitCode !== null) {
        throw new Error(`"${text}" never appeared. Output:\n${output}`)
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  beforeAll(async () => {
    await run(
      process.execPath,
      [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'host.vite.config.ts'],
      {
        cwd: ROOT
      }
    )
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-remote-agent-'))
    dataDir = await mkdtemp(join(tmpdir(), 'pi-remote-data-'))
    dirs.push(agentDir, dataDir)
    env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions')
    }
    delete env['ELECTRON_RUN_AS_NODE']
    host = spawn(
      process.execPath,
      [
        CLI,
        'start',
        '--data-dir',
        dataDir,
        '--port',
        String(port),
        '--host',
        '127.0.0.1',
        '--name',
        'test-server',
        '--pi',
        FAKE_PI
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    host.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    host.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    await waitFor('Ready.')
    socket = await controlSocketPath(dataDir)
  })

  afterAll(async () => {
    phone?.close()
    if (host && host.exitCode === null) {
      host.kill('SIGKILL')
    }
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('starts without a desktop and tells how to pair', async () => {
    expect(output).toContain('Run `pi-remote pair`')
    expect(output).toMatch(/pi \S+ \(custom/)
    const status = (await callControl(socket, { cmd: 'status' })) as RemoteStatus
    expect(status).toMatchObject({ running: true, port, addresses: ['127.0.0.1'], devices: [] })
    const cli = await run(process.execPath, [CLI, 'status', '--data-dir', dataDir], { env })
    expect(cli.stdout).toContain(`Listening on port ${port}`)
  })

  it('refuses a second host on the same data directory', async () => {
    const second = await run(
      process.execPath,
      [CLI, 'start', '--data-dir', dataDir, '--port', String(port + 1), '--pi', FAKE_PI],
      { env }
    ).catch((error: { stderr: string; code: number }) => error)
    expect((second as { code: number }).code).toBe(1)
    expect((second as { stderr: string }).stderr).toContain('already running')
  })

  it('pairs a phone with the code from the control socket', async () => {
    const code = (await callControl(socket, { cmd: 'pair' })) as { payload: string }
    const pairing = parsePairingPayload(code.payload)!
    expect(pairing).toMatchObject({ port, hosts: ['127.0.0.1'], name: 'test-server' })
    phone = await TestPhone.connect(pairing, generateKeyPair(), { pair: pairing.token })
    const ready = await phone.ready()
    expect(ready?.server).toMatchObject({ name: 'test-server', hosts: ['127.0.0.1'] })
    await waitFor('paired: Test phone')
    const status = (await callControl(socket, { cmd: 'status' })) as RemoteStatus
    expect(status.devices).toMatchObject([{ name: 'Test phone', connected: true }])
    expect(status.pairingExpiresAt).toBeNull()
  })

  it('serves the same channels as the desktop app, and only those', async () => {
    const info = await call<{ workspaceDir: string; platform: string }>('pi-desktop:app:info')
    expect(info.workspaceDir).toBe(join(dataDir, 'workspace'))
    expect(await call<unknown[]>('pi-desktop:sessions:list')).toEqual([])
    const cua = await call<{ available: boolean }>('pi-desktop:cua:permissions')
    expect(cua.available).toBe(false)
    for (const channel of [
      'pi-desktop:terminal:spawn',
      'pi-desktop:app:pick-folder',
      'pi-desktop:browser:navigate'
    ]) {
      await expect(call(channel, {})).rejects.toThrow('Not available from a paired device')
    }
  })

  it('runs a chat from the phone and streams it back', async () => {
    const chatId = 'host-e2e-chat'
    const opened = await call<{ models: unknown[] }>('pi-desktop:chat:open', {
      chatId,
      cwd: join(dataDir, 'workspace'),
      lite: true
    })
    expect(opened.models.length).toBeGreaterThan(0)
    phone.send({ t: 'sub', chats: [chatId] })
    await call('pi-desktop:chat:send', { chatId, message: 'hello from the phone', mode: 'prompt' })
    let reply = ''
    let settled = false
    while (!settled) {
      const frame = await phone.next(isEvent)
      expect(frame).not.toBeNull()
      if (frame!.ch !== 'pi-desktop:chat:event') {
        continue
      }
      const payload = frame!.d as {
        events: { type: string; message?: { role: string; content: { text?: string }[] } }[]
      }
      for (const event of payload.events) {
        settled ||= event.type === 'agent_settled'
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          reply = event.message.content.map((b) => b.text ?? '').join('')
        }
      }
    }
    expect(reply.length).toBeGreaterThan(0)
  })

  it('runs an automation without a window', async () => {
    const saved = await call<{ id: string }>('pi-desktop:automations:save', {
      name: 'Nightly check',
      prompt: 'check the build',
      cwd: '',
      schedule: { kind: 'daily', time: '03:00' },
      enabled: true
    })
    const before = await call<{ chatId: string }[]>('pi-desktop:remote:live-chats')
    await call('pi-desktop:automations:run-now', { id: saved.id })
    await waitFor('automation "Nightly check" started')
    const after = await call<{ chatId: string }[]>('pi-desktop:remote:live-chats')
    expect(after.length).toBe(before.length + 1)
    const [automation] = await call<{ id: string; lastRunAt?: number }[]>(
      'pi-desktop:automations:list'
    )
    expect(automation?.lastRunAt).toBeGreaterThan(0)
  })

  it('removes the phone from the command line', async () => {
    const cli = await run(process.execPath, [CLI, 'revoke', 'Test phone', '--data-dir', dataDir], {
      env
    })
    expect(cli.stdout).toContain('Removed Test phone')
    expect(await phone.next((f): f is ServerFrame => f.t === 'pong')).toBeNull() // socket closed
    await waitFor('removed: Test phone')
  })

  it('stops cleanly on SIGTERM', async () => {
    const exited = new Promise<number | null>((resolvePromise) => host.once('exit', resolvePromise))
    host.kill('SIGTERM')
    expect(await exited).toBe(0)
    expect(existsSync(socket)).toBe(false)
  })
})
