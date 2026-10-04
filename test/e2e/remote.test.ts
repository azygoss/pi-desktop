// Remote control end to end: the built app with the fake pi, and a phone
// that pairs with the code from Settings, then drives a chat through the
// same IPC handlers the window uses.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { generateKeyPair } from '../../src/shared/remote/crypto'
import type { AppSettings, RemoteStatusInfo } from '../../src/shared/api'
import { parsePairingPayload, type ServerFrame } from '../../src/shared/remote/protocol'
import { TestPhone } from '../fixtures/remote-phone'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const FAKE_PI = join(ROOT, 'test/fixtures/fake-pi.mjs')

type EventFrame = Extract<ServerFrame, { t: 'ev' }>
const isEvent = (f: ServerFrame): f is EventFrame => f.t === 'ev'

describe('remote control', () => {
  let app: ElectronApplication
  let page: Page
  let phone: TestPhone
  const dirs: string[] = []
  let nextId = 1

  const remoteStatus = (): Promise<RemoteStatusInfo> =>
    page.evaluate('window.piDesktop.remote.status()') as Promise<RemoteStatusInfo>

  async function call<T>(channel: string, arg?: unknown): Promise<T> {
    const res = await phone.request(nextId++, channel, arg)
    if (!res.ok) {
      throw new Error(res.e)
    }
    return res.d as T
  }

  beforeAll(async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'pi-desktop-remote-agent-'))
    const userDataDir = await mkdtemp(join(tmpdir(), 'pi-desktop-remote-ud-'))
    dirs.push(agentDir, userDataDir)
    const env = { ...process.env }
    delete env['ELECTRON_RUN_AS_NODE']
    app = await electron.launch({
      args: [join(ROOT, 'out/main/index.js')],
      env: {
        ...env,
        PI_DESKTOP_PI_COMMAND: FAKE_PI,
        PI_DESKTOP_E2E: '1',
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
        PI_DESKTOP_USER_DATA_DIR: userDataDir,
        NODE_ENV: 'production'
      }
    })
    page = await app.firstWindow()
    await page.waitForSelector('.composer-input', { state: 'visible', timeout: 30_000 })
  })

  afterAll(async () => {
    phone?.close()
    await app?.close()
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('is off until a pairing code is asked for', async () => {
    const status = await remoteStatus()
    expect(status.running).toBe(false)
    expect(status.devices).toHaveLength(0)
  })

  it('pairs a phone with the code from Settings', async () => {
    // Settings → Remote control → Show pairing code, as the user does it.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('pi-desktop:menu:action', 'open-settings')
    })
    await page.locator('.settings-nav-item', { hasText: 'Remote control' }).click()
    await page.locator('[data-testid="remote-pair"]').click()
    const qr = page.locator('[data-testid="remote-qr"]')
    await qr.waitFor({ state: 'visible', timeout: 10_000 })
    if (process.env['PI_DESKTOP_E2E_SHOTS']) {
      await page.screenshot({ path: join(process.env['PI_DESKTOP_E2E_SHOTS'], 'remote-pairing.png') })
    }
    const pairing = parsePairingPayload((await qr.getAttribute('data-payload')) ?? '')!
    expect(pairing).not.toBeNull()

    phone = await TestPhone.connect({ ...pairing, hosts: ['127.0.0.1'] }, generateKeyPair(), {
      pair: pairing.token
    })
    const ready = await phone.ready()
    expect(ready?.server.version).toMatch(/^\d+\.\d+\.\d+/)

    const status = await remoteStatus()
    expect(status.running).toBe(true)
    expect(status.pairingExpiresAt).toBeNull()
    expect(status.devices).toMatchObject([{ name: 'Test phone', connected: true }])
    const settings = (await page.evaluate('window.piDesktop.appSettings.get()')) as AppSettings
    expect(settings.remote.enabled).toBe(true)
    // The spent code leaves the screen and the phone is listed as connected.
    await qr.waitFor({ state: 'detached', timeout: 10_000 })
    const device = page.locator('[data-testid="remote-device"]')
    await device.waitFor({ state: 'visible', timeout: 10_000 })
    expect(await device.innerText()).toContain('Test phone')
    expect(await device.innerText()).toContain('Connected')
    if (process.env['PI_DESKTOP_E2E_SHOTS']) {
      await page.screenshot({ path: join(process.env['PI_DESKTOP_E2E_SHOTS'], 'remote-paired.png') })
    }
  })

  it('answers allowed requests and refuses the rest', async () => {
    const info = await call<{ workspaceDir: string; version: string }>('pi-desktop:app:info')
    expect(info.workspaceDir).toContain('workspace')
    expect(await call<unknown[]>('pi-desktop:sessions:list')).toEqual([])
    const dirsAtHome = await call<{ path: string; dirs: string[] }>('pi-desktop:remote:list-dirs', {})
    expect(dirsAtHome.path.length).toBeGreaterThan(1)
    for (const channel of [
      'pi-desktop:app:quit',
      'pi-desktop:terminal:spawn',
      'pi-desktop:app-settings:update',
      'pi-desktop:remote:begin-pairing',
      'pi-desktop:app:pick-folder'
    ]) {
      await expect(call(channel, {})).rejects.toThrow('Not available from a paired device')
    }
  })

  it('runs a chat from the phone and streams it back', async () => {
    const { workspaceDir } = await call<{ workspaceDir: string }>('pi-desktop:app:info')
    const chatId = 'remote-e2e-chat'
    const opened = await call<{ models: unknown[]; messages: unknown[]; sessionPath?: string }>(
      'pi-desktop:chat:open',
      { chatId, cwd: workspaceDir, lite: true }
    )
    expect(opened.models.length).toBeGreaterThan(0)
    expect(opened.messages).toEqual([])

    phone.send({ t: 'sub', chats: [chatId] })
    await call('pi-desktop:chat:send', { chatId, message: 'hello from the phone', mode: 'prompt' })

    const types: string[] = []
    let reply = ''
    while (!types.includes('agent_settled')) {
      const frame = await phone.next(isEvent)
      expect(frame).not.toBeNull()
      if (frame!.ch !== 'pi-desktop:chat:event') {
        continue
      }
      const payload = frame!.d as {
        chatId: string
        events: { type: string; message?: { role: string; content: { type: string; text?: string }[] } }[]
      }
      expect(payload.chatId).toBe(chatId)
      for (const event of payload.events) {
        types.push(event.type)
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          reply = event.message.content.map((b) => b.text ?? '').join('')
        }
      }
    }
    expect(types).toContain('agent_start')
    expect(types).toContain('message_update')
    expect(reply.length).toBeGreaterThan(0)

    // The chat is visible to both sides: live on the computer, and the
    // window would join it (not start a second pi) when its session is opened.
    const live = await call<{ chatId: string; streaming: boolean; sessionPath?: string }[]>(
      'pi-desktop:remote:live-chats'
    )
    const mine = live.find((c) => c.chatId === chatId)
    expect(mine?.streaming).toBe(false)
    if (mine?.sessionPath) {
      expect(await call('pi-desktop:chat:id-for-session', { sessionPath: mine.sessionPath })).toBe(chatId)
    }
  })

  it('cuts the phone off when it is removed', async () => {
    const status = await remoteStatus()
    await page.evaluate(
      `window.piDesktop.remote.revoke({ deviceId: ${JSON.stringify(status.devices[0]!.id)} })`
    )
    expect(await phone.next((f): f is ServerFrame => f.t === 'pong')).toBeNull() // socket closed
    const after = await remoteStatus()
    expect(after.devices).toHaveLength(0)
  })
})
