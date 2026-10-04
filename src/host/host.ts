import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

import type { Automation } from '../shared/automations'
import { AutomationScheduler } from '../main/automations/scheduler'
import {
  listAutomations,
  markAutomationRun,
  setAutomationSession
} from '../main/automations/automation-store'
import { ChatService } from '../main/chat/chat-service'
import { SideChatService } from '../main/chat/side-service'
import { loadAppSettings } from '../main/config/app-settings'
import { appUserDataDir, ensureWorkspaceDir, workspaceDir } from '../main/config/app-paths'
import {
  IPC_CHANNELS,
  REMOTE_FORWARD,
  broadcastAll,
  closeRemoteSides,
  invokeRemote,
  registerIpcHandlers,
  runtimeOptionsFromSettings,
  setRemoteSink,
  startSessionWatcher,
  type IpcDeps
} from '../main/ipc'
import { PiProcessPool } from '../main/pi/pool'
import { RemoteServer, localHosts, type RemoteStatus } from '../main/remote/remote-server'
import { RemoteStore } from '../main/remote/remote-store'

/**
 * The headless remote-control host: what Pi Desktop's main process does for
 * a paired phone, without a window. Chats, sessions, projects, diffs, pull
 * requests, automations and side chats run through the same IPC handlers
 * (and the same allowlist) as the desktop app; only the window-bound parts
 * — the in-app browser, computer use, dictation, terminal tabs — are absent.
 */

/** How long an automation run may take to write its session file. */
const SESSION_WAIT_MS = 10 * 60_000
const SESSION_POLL_MS = 2000

const fileExists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

/**
 * The pi extension (show_image): packed next to pi-remote.mjs, or in the
 * repository when run from a build in out/host.
 */
function hostExtensionPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const base of [join(here, 'pi-extension'), join(here, '..', '..', 'resources', 'pi-extension')]) {
    const file = join(base, 'pi-desktop-browser', 'index.js')
    if (existsSync(file)) {
      return file
    }
  }
  return ''
}

export interface HostOptions {
  /** Port to listen on; the next free one is used unless `strictPort`. */
  port?: number
  strictPort?: boolean
  /** Interface to listen on (default: all). */
  bind?: string
  /** Addresses the phone should use, in order (default: this machine's). */
  publicHosts?: string[]
  /** Name the phone shows for this machine (default: the hostname). */
  name?: string
  version: string
  log(line: string): void
}

export interface Host {
  status(): RemoteStatus
  beginPairing(): { payload: string; expiresAt: number }
  cancelPairing(): void
  revoke(deviceId: string): Promise<void>
  /** Resolves with how pi was found, or rejects when it cannot be run. */
  runtime(): Promise<{ kind: string; version: string | null; command: string }>
  stop(): Promise<void>
}

export async function startHost(options: HostOptions): Promise<Host> {
  const { log } = options
  const settings = await loadAppSettings()
  await ensureWorkspaceDir()

  // PI_DESKTOP_PI_COMMAND (the CLI's --pi) wins over the saved setting.
  const pool = new PiProcessPool(runtimeOptionsFromSettings(settings))
  // No loopback bridge (the browser and computer tools need a desktop), but
  // the extension still loads for show_image.
  const extensionPath = hostExtensionPath()
  const chat = new ChatService(pool, broadcastAll, {
    url: () => '',
    issue: () => '',
    revoke: () => {},
    extensionPath: () => extensionPath
  })
  const side = new SideChatService(pool, broadcastAll)

  const name = options.name || hostname().replace(/\.local$/, '') || 'Server'
  // Log phones coming and going (the journal is the host's only window).
  let known = new Map<string, { name: string; connected: boolean }>()
  const logChanges = (status: RemoteStatus): void => {
    const next = new Map(
      status.devices.map((d) => [d.id, { name: d.name, connected: d.connected }])
    )
    for (const [id, device] of next) {
      const before = known.get(id)
      if (!before) {
        log(`paired: ${device.name}`)
      }
      if (before?.connected !== device.connected && (before || device.connected)) {
        log(`${device.connected ? 'connected' : 'disconnected'}: ${device.name}`)
      }
    }
    for (const [id, device] of known) {
      if (!next.has(id)) {
        log(`removed: ${device.name}`)
      }
    }
    known = next
  }
  let ready = false
  const remote = new RemoteServer({
    // No OS keychain on a server: the identity key lives in a file only
    // this user can read (remote.json is written with mode 0600).
    store: new RemoteStore(join(appUserDataDir(), 'remote.json')),
    invoke: invokeRemote,
    onDeviceGone: closeRemoteSides,
    forward: REMOTE_FORWARD,
    info: () => ({
      name,
      version: options.version,
      platform: process.platform,
      homeDir: homedir(),
      workspaceDir: workspaceDir(),
      tzOffset: new Date().getTimezoneOffset(),
      kind: 'server'
    }),
    hosts: () =>
      options.publicHosts && options.publicHosts.length > 0 ? options.publicHosts : localHosts(),
    ...(options.port ? { port: options.port } : {}),
    ...(options.bind ? { bind: options.bind } : {}),
    ...(options.strictPort ? { portAttempts: 1 } : {}),
    onChanged: () => {
      if (ready) {
        logChanges(remote.status())
      }
    }
  })
  setRemoteSink((channel, payload) => remote.broadcast(channel, payload))

  /**
   * Run an automation as a background chat (the desktop does it in its
   * window). Resolves once pi accepted the prompt: false if it could not
   * start, so the scheduler tries again instead of counting the run.
   */
  const runAutomation = async (automation: Automation): Promise<boolean> => {
    const chatId = randomUUID()
    const cwd = automation.cwd || workspaceDir()
    try {
      await chat.open({ chatId, cwd })
      await chat.send({ chatId, message: automation.prompt, mode: 'prompt' })
    } catch (error) {
      log(
        `automation "${automation.name}" could not start: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      await chat.close({ chatId }).catch(() => {})
      return false
    }
    log(`automation "${automation.name}" started`)
    void nameAutomationRun(chatId, automation)
    return true
  }
  /** Once pi has written the run's session file: name it and remember it. */
  const nameAutomationRun = async (chatId: string, automation: Automation): Promise<void> => {
    const until = Date.now() + SESSION_WAIT_MS
    while (Date.now() < until && chat.hasProcess(chatId)) {
      const sessionPath = await chat.sessionFile({ chatId }).catch(() => undefined)
      if (sessionPath && (await fileExists(sessionPath))) {
        await chat.setSessionName({ chatId, name: automation.name }).catch(() => {})
        await setAutomationSession(automation.id, sessionPath).catch(() => {})
        broadcastAll(IPC_CHANNELS.automationsChanged, null)
        return
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, SESSION_POLL_MS))
    }
  }
  const trigger = (automation: Automation): Promise<boolean> => runAutomation(automation)
  const automations = new AutomationScheduler({
    list: listAutomations,
    markRun: async (id, at) => {
      await markAutomationRun(id, at)
      broadcastAll(IPC_CHANNELS.automationsChanged, null)
    },
    trigger
  })

  // Terminal tabs and the in-app browser are window features: the phone
  // cannot reach their channels, so nothing ever calls into these.
  const absent = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('Not available without a desktop window')
      }
    }
  )
  registerIpcHandlers({
    pool,
    chat,
    side,
    pty: absent as IpcDeps['pty'],
    browser: absent as IpcDeps['browser'],
    remote: {
      apply: (enabled) => (enabled ? remote.start() : remote.stop()),
      loadDevices: () => remote.loadDevices(),
      status: () => remote.status(),
      beginPairing: () => remote.beginPairing(),
      cancelPairing: () => remote.cancelPairing(),
      revoke: (deviceId) => remote.revoke(deviceId)
    },
    automations: { refresh: () => automations.refresh(), trigger }
  })

  await remote.start()
  known = new Map(
    remote.status().devices.map((d) => [d.id, { name: d.name, connected: d.connected }])
  )
  ready = true
  const stopWatcher = startSessionWatcher()
  automations.start()
  // A warm pi for the first project-less chat, as in the desktop app.
  setTimeout(() => void chat.warmSpare(), 1000).unref?.()

  let stopping: Promise<void> | null = null
  return {
    status: () => remote.status(),
    beginPairing: () => remote.beginPairing(),
    cancelPairing: () => remote.cancelPairing(),
    revoke: (deviceId) => remote.revoke(deviceId),
    runtime: async () => {
      const runtime = await pool.getRuntime()
      return { kind: runtime.kind, version: runtime.version, command: runtime.command }
    },
    stop: () => {
      stopping ??= (async () => {
        automations.stop()
        stopWatcher()
        setRemoteSink(null)
        await remote.stop().catch(() => {})
        await side.closeAll().catch(() => {})
        await chat.closeAll().catch(() => {})
      })()
      return stopping
    }
  }
}
