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
import { loadAppSettings } from './config/app-settings'
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

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1a1a19',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => {
    win.show()
  })

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

app.whenReady().then(async () => {
  await ensureWorkspaceDir().catch(() => {})
  const appSettings = await loadAppSettings().catch(() => null)
  if (appSettings) {
    pool.setRuntimeOptions(runtimeOptionsFromSettings(appSettings))
  }
  await bridge.start().catch(() => {})
  if (bridge.running) {
    bridge.setHandler((call) => browserTools.call(call.chatId, call.tool, call.params))
  }
  registerIpcHandlers({ pool, chat, pty, browser, bridge })
  startSessionWatcher()
  wireAppLifecycle({ pool, chat, pty, browser, bridge })
  installAppMenu(isDev)
  createWindow()

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
