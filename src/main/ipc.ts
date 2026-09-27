import { basename } from 'node:path'
import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import type { ChatOpenInput, ChatSendInput } from '../shared/api'
import type { PiRuntimeInfo } from '../shared/session-types'
import type { ThinkingLevel } from '../shared/pi-types'
import type { PiProcessPool } from './pi/pool'
import { CHAT_CHANNELS, ChatService } from './chat/chat-service'
import { readSettings } from './config/settings'
import { listProjects, listSessions, watchSessions } from './sessions/session-index'

export const IPC_CHANNELS = {
  runtimeInfo: 'pi-desktop:runtime:info',
  sessionsList: 'pi-desktop:sessions:list',
  projectsList: 'pi-desktop:projects:list',
  settingsGet: 'pi-desktop:settings:get',
  appUserFirstName: 'pi-desktop:app:user-first-name',
  appPickFolder: 'pi-desktop:app:pick-folder',
  sessionsChanged: 'pi-desktop:sessions:changed',
  chatOpen: 'pi-desktop:chat:open',
  chatSend: 'pi-desktop:chat:send',
  chatAbort: 'pi-desktop:chat:abort',
  chatSetModel: 'pi-desktop:chat:set-model',
  chatSetThinkingLevel: 'pi-desktop:chat:set-thinking-level',
  chatGetStats: 'pi-desktop:chat:get-stats',
  chatSetCwd: 'pi-desktop:chat:set-cwd',
  chatRespondUi: 'pi-desktop:chat:respond-ui',
  chatClose: 'pi-desktop:chat:close'
} as const

export interface IpcDeps {
  pool: PiProcessPool
  chat: ChatService
}

function usernameFallback(): string {
  try {
    return userInfo().username || 'there'
  } catch {
    return 'there'
  }
}

/**
 * Best-effort first name for the greeting: on macOS `id -F` returns the
 * account's full name; take its first word. Falls back to the username.
 */
function resolveUserFirstName(): Promise<string> {
  if (process.platform !== 'darwin') {
    return Promise.resolve(usernameFallback())
  }
  return new Promise((resolvePromise) => {
    execFile('id', ['-F'], { timeout: 2000 }, (error, stdout) => {
      const first = stdout.trim().split(/\s+/)[0]
      resolvePromise(!error && first ? first : usernameFallback())
    })
  })
}

/** Register all IPC handlers for the typed `window.piDesktop` preload API. */
export function registerIpcHandlers(deps: IpcDeps): void {
  ipcMain.handle(IPC_CHANNELS.runtimeInfo, async (): Promise<PiRuntimeInfo> => {
    const runtime = await deps.pool.getRuntime()
    return { kind: runtime.kind, version: runtime.version, command: basename(runtime.command) }
  })

  ipcMain.handle(IPC_CHANNELS.sessionsList, () => listSessions())

  ipcMain.handle(IPC_CHANNELS.projectsList, async () => listProjects(await listSessions()))

  ipcMain.handle(IPC_CHANNELS.settingsGet, () => readSettings())

  ipcMain.handle(IPC_CHANNELS.appUserFirstName, () => resolveUserFirstName())

  ipcMain.handle(IPC_CHANNELS.appPickFolder, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0]!, {
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC_CHANNELS.chatOpen, (_e, input: ChatOpenInput) => deps.chat.open(input))
  ipcMain.handle(IPC_CHANNELS.chatSend, (_e, input: ChatSendInput) => deps.chat.send(input))
  ipcMain.handle(IPC_CHANNELS.chatAbort, (_e, input: { chatId: string }) =>
    deps.chat.abort(input)
  )
  ipcMain.handle(
    IPC_CHANNELS.chatSetModel,
    (_e, input: { chatId: string; provider: string; modelId: string }) =>
      deps.chat.setModel(input)
  )
  ipcMain.handle(
    IPC_CHANNELS.chatSetThinkingLevel,
    (_e, input: { chatId: string; level: ThinkingLevel }) => deps.chat.setThinkingLevel(input)
  )
  ipcMain.handle(IPC_CHANNELS.chatGetStats, (_e, input: { chatId: string }) =>
    deps.chat.getStats(input)
  )
  ipcMain.handle(IPC_CHANNELS.chatSetCwd, (_e, input: { chatId: string; cwd: string }) =>
    deps.chat.setCwd(input)
  )
  ipcMain.handle(
    IPC_CHANNELS.chatRespondUi,
    (_e, input: { chatId: string } & Record<string, unknown>) => deps.chat.respondUi(input)
  )
  ipcMain.handle(IPC_CHANNELS.chatClose, (_e, input: { chatId: string }) => deps.chat.close(input))
}

/**
 * Broadcast session-index changes to every renderer. Returns a cleanup
 * function; callers should invoke it on app shutdown.
 */
export function startSessionWatcher(): () => void {
  return watchSessions(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.sessionsChanged)
    }
  })
}

export function wireAppLifecycle(deps: IpcDeps): void {
  app.on('before-quit', () => {
    void deps.chat.closeAll()
  })
}

/** Send a channel message to all open windows. */
export function broadcastAll(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export { CHAT_CHANNELS }
