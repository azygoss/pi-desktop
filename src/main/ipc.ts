import { basename } from 'node:path'
import { userInfo } from 'node:os'
import { BrowserWindow, app, ipcMain } from 'electron'
import type { PiRuntimeInfo } from '../shared/session-types'
import type { PiProcessPool } from './pi/pool'
import { readSettings } from './config/settings'
import { listProjects, listSessions, watchSessions } from './sessions/session-index'

export const IPC_CHANNELS = {
  runtimeInfo: 'pi-desktop:runtime:info',
  sessionsList: 'pi-desktop:sessions:list',
  projectsList: 'pi-desktop:projects:list',
  settingsGet: 'pi-desktop:settings:get',
  appUserFirstName: 'pi-desktop:app:user-first-name',
  sessionsChanged: 'pi-desktop:sessions:changed'
} as const

export interface IpcDeps {
  pool: PiProcessPool
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

  ipcMain.handle(IPC_CHANNELS.appUserFirstName, () => {
    try {
      const username = userInfo().username
      return username || 'there'
    } catch {
      return 'there'
    }
  })
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
    void deps.pool.closeAll()
  })
}
