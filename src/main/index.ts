import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { BrowserWindow, app, globalShortcut, nativeTheme, shell } from 'electron'
import {
  IPC_CHANNELS,
  broadcastAll,
  registerIpcHandlers,
  runtimeOptionsFromSettings,
  startSessionWatcher,
  wireAppLifecycle
} from './ipc'
import { loadAppSettings, updateAppSettings, getCachedAppSettings, type AppSettings } from './config/app-settings'
import { ensureWorkspaceDir } from './config/app-paths'
import { BridgeServer } from './bridge/bridge-server'
import { BrowserToolBridge } from './bridge/browser-tools'
import { BrowserManager } from './browser/browser-manager'
import { CuaService } from './cua/cua-service'
import { ComputerToolBridge } from './cua/cua-tools'
import { DictationService } from './dictation/dictation-service'
import { UpdateChecker } from './updates/update-check'
import { AutomationScheduler } from './automations/scheduler'
import { listAutomations, markAutomationRun } from './automations/automation-store'
import type { Automation } from '../shared/automations'
import { ChatService } from './chat/chat-service'
import { installAppMenu } from './menu'
import { PiProcessPool } from './pi/pool'
import { PtyManager } from './terminal/pty-manager'

const pool = new PiProcessPool({
  // Test/dev override: point at a custom pi executable (e.g. a fixture).
  customPath: process.env['PI_DESKTOP_PI_COMMAND'] || undefined
})
const bridge = new BridgeServer()
// Computer use: the Swift helper supervises AX/CGEvent/screenshot work; when
// the binary is missing (non-mac, dev without a build) available() is false
// and the computer_* tools simply aren't offered to pi.
const cua = new CuaService()
// Dictation: the Swift speech helper; absent on non-macOS/dev without a build.
const dictation = new DictationService()
dictation.onEvent((event) => broadcastAll(IPC_CHANNELS.dictationEvent, event))
// Release check: caches the last-found update and pushes it to every window.
const updates = new UpdateChecker({}, (info) =>
  broadcastAll(IPC_CHANNELS.appUpdateAvailable, info)
)
const chat = new ChatService(pool, broadcastAll, {
  url: () => bridge.url,
  issue: (chatId) => bridge.issue(chatId),
  revoke: (chatId) => bridge.revoke(chatId),
  adopt: (fromChatId, toChatId) => bridge.adopt(fromChatId, toChatId),
  extensionPath: piExtensionPath,
  computerToolsEnabled: () =>
    cua.available() && (getCachedAppSettings()?.computerUse.enabled ?? true)
})
const computerTools = new ComputerToolBridge(cua, {
  isEnabled: async () => (await loadAppSettings()).computerUse.enabled
})
cua.onActivity((event) => {
  broadcastAll(IPC_CHANNELS.cuaActivity, event)
  updateCuaShortcut(event)
})

// While the agent is driving a Mac app, Control+Option+Command+P toggles the
// pause gate anywhere in the OS. The shortcut is only held while activity is
// live — it unregisters 4s after the last 'end' so we don't hog the chord.
const CUA_PAUSE_ACCELERATOR = 'Control+Option+Command+P'
let cuaShortcutRegistered = false
let cuaShortcutTimer: ReturnType<typeof setTimeout> | null = null
function updateCuaShortcut(event: { phase: string }): void {
  if (process.platform !== 'darwin' || !cua.available()) {
    return
  }
  if (event.phase === 'start') {
    if (cuaShortcutTimer) {
      clearTimeout(cuaShortcutTimer)
      cuaShortcutTimer = null
    }
    if (!cuaShortcutRegistered) {
      cuaShortcutRegistered = globalShortcut.register(CUA_PAUSE_ACCELERATOR, () => {
        if (cua.paused) {
          cua.resume()
        } else {
          cua.pause()
        }
      })
    }
    return
  }
  if (event.phase === 'end') {
    if (cuaShortcutTimer) {
      clearTimeout(cuaShortcutTimer)
    }
    cuaShortcutTimer = setTimeout(() => {
      cuaShortcutTimer = null
      if (cuaShortcutRegistered) {
        globalShortcut.unregister(CUA_PAUSE_ACCELERATOR)
        cuaShortcutRegistered = false
      }
    }, 4000)
    cuaShortcutTimer.unref?.()
  }
}
app.on('will-quit', () => {
  if (cuaShortcutRegistered) {
    globalShortcut.unregister(CUA_PAUSE_ACCELERATOR)
    cuaShortcutRegistered = false
  }
})
/** Hand a due automation to a window, which runs it as a background chat. */
function triggerAutomation(automation: Automation): boolean {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.webContents.isLoading()) {
    return false
  }
  win.webContents.send(IPC_CHANNELS.automationsRun, automation)
  return true
}
const automations = new AutomationScheduler({
  list: listAutomations,
  markRun: async (id, at) => {
    await markAutomationRun(id, at)
    broadcastAll(IPC_CHANNELS.automationsChanged, null)
  },
  trigger: triggerAutomation
})
app.on('will-quit', () => automations.stop())

const pty = new PtyManager({
  onData: (id, data) => broadcastAll(IPC_CHANNELS.terminalData, { id, data }),
  onExit: (id, exitCode, signal) =>
    broadcastAll(IPC_CHANNELS.terminalExit, { id, exitCode, signal })
})
const browser = new BrowserManager({
  onState: (state) => broadcastAll(IPC_CHANNELS.browserState, state),
  onOpenUrl: (url) => broadcastAll(IPC_CHANNELS.browserOpenUrl, { url }),
  onDownload: (filename) => broadcastAll(IPC_CHANNELS.browserDownloaded, { filename })
})
const browserTools = new BrowserToolBridge(browser, (id, chatId, action) =>
  broadcastAll(IPC_CHANNELS.browserAgentTab, { id, chatId, action })
)

/**
 * The pi extension that registers the browser_* tools. Packaged builds carry
 * it in extraResources (the installed pi runtime cannot read inside asar).
 * In dev/unpackaged launches app.getAppPath() can point at out/main rather
 * than the repo root, so both locations are probed.
 */
function piExtensionPath(): string {
  const bases = app.isPackaged
    ? [join(process.resourcesPath, 'pi-extension')]
    : [
        join(import.meta.dirname, '../../resources/pi-extension'),
        join(app.getAppPath(), 'resources', 'pi-extension')
      ]
  for (const base of bases) {
    const file = join(base, 'pi-desktop-browser', 'index.js')
    if (existsSync(file)) {
      return file
    }
  }
  return ''
}

const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL']

/**
 * Persist window geometry (debounced; getNormalBounds reports the restored
 * frame even while maximized).
 */
function trackWindowBounds(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const persist = () => {
    const bounds = win.getNormalBounds()
    void updateAppSettings({
      windowBounds: {
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        maximized: win.isMaximized()
      }
    }).catch(() => {})
  }
  const schedule = () => {
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(persist, 400)
    timer.unref?.()
  }
  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.on('close', persist)
}

function createWindow(): BrowserWindow {
  const savedBounds = lastSettings?.windowBounds
  const win = new BrowserWindow({
    width: savedBounds?.width ?? 1280,
    height: savedBounds?.height ?? 800,
    ...(savedBounds?.x !== undefined && savedBounds.y !== undefined
      ? { x: savedBounds.x, y: savedBounds.y }
      : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          // Traffic lights vertically centered on the 44px top strips, which
          // start 8px down (the sheets are inset from the window chrome).
          trafficLightPosition: { x: 16, y: 24 },
          // Sidebar material shows through where the renderer is transparent;
          // an opaque backgroundColor would cover it, so it stays unset.
          vibrancy: 'sidebar' as const
        }
      : { backgroundColor: '#161618' }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => {
    if (savedBounds?.maximized) {
      win.maximize()
    }
    win.show()
  })

  trackWindowBounds(win)

  const devUrl = process.env['ELECTRON_RENDERER_URL']

  // No in-app navigation away from the loaded page; external https links go to
  // the system browser instead of an Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev && devUrl ? url.startsWith(devUrl) : url.startsWith('file:')
    if (!allowed) {
      event.preventDefault()
      if (url.startsWith('https:')) {
        void shell.openExternal(url)
      }
    }
  })

  if (isDev && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return win
}

let lastSettings: AppSettings | null = null

app.whenReady().then(async () => {
  // Settings are a tiny file read needed for window bounds — keep this
  // before createWindow; every heavier subsystem is deferred past paint.
  lastSettings = await loadAppSettings().catch(() => null)

  // The vibrancy material follows nativeTheme; keep it on the app theme
  // even when that differs from the system appearance.
  nativeTheme.themeSource = lastSettings?.theme ?? 'system'

  registerIpcHandlers({
    pool,
    chat,
    pty,
    browser,
    bridge,
    cua,
    dictation,
    updates,
    automations: { refresh: () => automations.refresh(), trigger: triggerAutomation }
  })
  wireAppLifecycle({ pool, chat, pty, browser, bridge, cua, dictation })
  installAppMenu(isDev)
  const win = createWindow()

  // Deferred startup: runtime resolution, bridge server, session watcher
  // and the warm spare all wait until the renderer has painted, so launch
  // never blocks on pi discovery or socket setup.
  win.webContents.once('did-finish-load', () => {
    void (async () => {
      await ensureWorkspaceDir().catch(() => {})
      if (lastSettings) {
        pool.setRuntimeOptions(runtimeOptionsFromSettings(lastSettings))
      }
      await bridge.start().catch(() => {})
      if (bridge.running) {
        bridge.setHandler((call) =>
          call.tool.startsWith('computer_')
            ? computerTools.call(call.chatId, call.tool, call.params)
            : browserTools.call(call.chatId, call.tool, call.params)
        )
      }
      startSessionWatcher()
      // Release check: silent unless a newer version exists; repeated daily.
      const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
      const runUpdateCheck = () => {
        if (getCachedAppSettings()?.updates.check !== false) {
          void updates.run().catch(() => {})
        }
      }
      setTimeout(runUpdateCheck, 5000).unref?.()
      setInterval(runUpdateCheck, UPDATE_INTERVAL_MS).unref?.()
      // Warm spare pi for the next project-less chat — spawned a couple of
      // seconds later; pi's own startup (eager extensions, MCP servers) can
      // take seconds and the spare absorbs it for the first draft.
      setTimeout(() => void chat.warmSpare(), 2000).unref?.()
      // Automations: runs missed while the app was closed fire once now.
      setTimeout(() => automations.start(), 4000).unref?.()
    })()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
