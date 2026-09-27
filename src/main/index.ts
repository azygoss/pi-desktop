import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { BrowserWindow, app, shell } from 'electron'
import {
  IPC_CHANNELS,
  broadcastAll,
  registerIpcHandlers,
  runtimeOptionsFromSettings,
  startSessionWatcher,
  wireAppLifecycle
} from './ipc'
import { loadAppSettings, updateAppSettings, type AppSettings } from './config/app-settings'
import { ensureWorkspaceDir } from './config/app-paths'
import { BridgeServer } from './bridge/bridge-server'
import { BrowserToolBridge } from './bridge/browser-tools'
import { BrowserManager } from './browser/browser-manager'
import { ChatService } from './chat/chat-service'
import { installAppMenu } from './menu'
import { PiProcessPool } from './pi/pool'
import { PtyManager } from './terminal/pty-manager'

const pool = new PiProcessPool({
  // Test/dev override: point at a custom pi executable (e.g. a fixture).
  customPath: process.env['PI_DESKTOP_PI_COMMAND'] || undefined
})
const bridge = new BridgeServer()
const chat = new ChatService(pool, broadcastAll, {
  url: () => bridge.url,
  issue: (chatId) => bridge.issue(chatId),
  revoke: (chatId) => bridge.revoke(chatId),
  adopt: (fromChatId, toChatId) => bridge.adopt(fromChatId, toChatId),
  extensionPath: piExtensionPath
})
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
          // Traffic lights vertically centered on the 44px top strips.
          trafficLightPosition: { x: 14, y: 16 },
          // Sidebar material shows through where the renderer is transparent;
          // an opaque backgroundColor would cover it, so it stays unset.
          vibrancy: 'sidebar' as const
        }
      : { backgroundColor: '#1a1a19' }),
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

  registerIpcHandlers({ pool, chat, pty, browser, bridge })
  wireAppLifecycle({ pool, chat, pty, browser, bridge })
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
        bridge.setHandler((call) => browserTools.call(call.chatId, call.tool, call.params))
      }
      startSessionWatcher()
      // Warm spare pi for the next project-less chat — spawned a couple of
      // seconds later; pi's own startup (eager extensions, MCP servers) can
      // take seconds and the spare absorbs it for the first draft.
      setTimeout(() => void chat.warmSpare(), 2000).unref?.()
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
