import { basename } from 'node:path'
import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
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
  appPickFile: 'pi-desktop:app:pick-file',
  appSaveFile: 'pi-desktop:app:save-file',
  appRevealPath: 'pi-desktop:app:reveal-path',
  appConfirmDialog: 'pi-desktop:app:confirm-dialog',
  sessionsChanged: 'pi-desktop:sessions:changed',
  chatOpen: 'pi-desktop:chat:open',
  chatSend: 'pi-desktop:chat:send',
  chatAbort: 'pi-desktop:chat:abort',
  chatSetModel: 'pi-desktop:chat:set-model',
  chatSetThinkingLevel: 'pi-desktop:chat:set-thinking-level',
  chatGetStats: 'pi-desktop:chat:get-stats',
  chatSetCwd: 'pi-desktop:chat:set-cwd',
  chatCompact: 'pi-desktop:chat:compact',
  chatSetSessionName: 'pi-desktop:chat:set-session-name',
  chatExportHtml: 'pi-desktop:chat:export-html',
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

  ipcMain.handle(
    IPC_CHANNELS.appPickFile,
    async (event, input: { filters?: { name: string; extensions: string[] }[] }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const filters = Array.isArray(input?.filters)
        ? input.filters
            .filter(
              (f): f is { name: string; extensions: string[] } =>
                typeof f?.name === 'string' &&
                Array.isArray(f.extensions) &&
                f.extensions.every((e) => typeof e === 'string' && e.length < 32)
            )
            .slice(0, 10)
        : undefined
      const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0]!, {
        properties: ['openFile'],
        ...(filters ? { filters } : {})
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.appSaveFile,
    async (event, input: { defaultPath?: string; extension: string }) => {
      if (typeof input?.extension !== 'string' || !/^[a-z0-9]{1,10}$/i.test(input.extension)) {
        throw new Error('Invalid extension')
      }
      const defaultPath =
        typeof input.defaultPath === 'string' && input.defaultPath.length < 1024
          ? input.defaultPath
          : undefined
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showSaveDialog(win ?? BrowserWindow.getAllWindows()[0]!, {
        defaultPath,
        filters: [{ name: input.extension.toUpperCase(), extensions: [input.extension] }]
      })
      return result.canceled ? null : (result.filePath ?? null)
    }
  )

  ipcMain.handle(IPC_CHANNELS.appRevealPath, (_e, path: string) => {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error('Invalid path')
    }
    shell.showItemInFolder(path)
  })

  ipcMain.handle(
    IPC_CHANNELS.appConfirmDialog,
    async (
      event,
      input: { title: string; message?: string; buttons: string[]; danger?: boolean }
    ) => {
      if (
        typeof input?.title !== 'string' ||
        !Array.isArray(input.buttons) ||
        input.buttons.length === 0 ||
        input.buttons.length > 4 ||
        !input.buttons.every((b) => typeof b === 'string' && b.length > 0 && b.length < 64)
      ) {
        throw new Error('Invalid dialog input')
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showMessageBox(win ?? BrowserWindow.getAllWindows()[0]!, {
        type: input.danger ? 'warning' : 'info',
        message: input.title,
        detail: typeof input.message === 'string' ? input.message : undefined,
        buttons: input.buttons,
        defaultId: input.danger ? input.buttons.length - 1 : 0,
        cancelId: input.danger ? input.buttons.length - 1 : undefined
      })
      return result.response
    }
  )

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
    IPC_CHANNELS.chatCompact,
    (_e, input: { chatId: string; customInstructions?: string }) => deps.chat.compact(input)
  )
  ipcMain.handle(
    IPC_CHANNELS.chatSetSessionName,
    (_e, input: { chatId: string; name: string }) => deps.chat.setSessionName(input)
  )
  ipcMain.handle(
    IPC_CHANNELS.chatExportHtml,
    (_e, input: { chatId: string; outputPath: string }) => deps.chat.exportHtml(input)
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
