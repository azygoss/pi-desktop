import { basename, isAbsolute, resolve } from 'node:path'
import { copyFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron'
import type {
  AppSettings,
  BrowserRect,
  ChatMenuAction,
  ChatOpenInput,
  ChatSendInput,
  MenuAction,
  ProjectMenuAction,
  SessionMenuAction,
  TerminalSpawnInput
} from '../shared/api'
import type { PiRuntimeInfo } from '../shared/session-types'
import type { ThinkingLevel } from '../shared/pi-types'
import type { PiProcessPool } from './pi/pool'
import { CHAT_CHANNELS, ChatService } from './chat/chat-service'
import { validateChatId, validateCwd, validateSessionPath } from './chat/validation'
import { loadAppSettings, updateAppSettings } from './config/app-settings'
import { workspaceDir } from './config/app-paths'
import { readSettings } from './config/settings'
import { loginShellEnv } from './pi/locator'
import { BrowserManager } from './browser/browser-manager'
import { getRepoDiff } from './diff/git-diff'
import { importSessionFile } from './sessions/import-session'
import { getAgentDir } from './sessions/paths'
import { listSessions, watchSessions } from './sessions/session-index'
import { readSessionTranscript } from './sessions/transcript'
import { getCatalogCache } from './config/catalog-cache'
import { mergeProjects } from './sessions/projects'
import { PtyManager } from './terminal/pty-manager'

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
  appInfo: 'pi-desktop:app:info',
  appOpenAgentDir: 'pi-desktop:app:open-agent-dir',
  menuAction: 'pi-desktop:menu:action',
  runtimeRefresh: 'pi-desktop:runtime:refresh',
  appSettingsGet: 'pi-desktop:app-settings:get',
  appSettingsUpdate: 'pi-desktop:app-settings:update',
  sessionsChanged: 'pi-desktop:sessions:changed',
  sessionsRename: 'pi-desktop:sessions:rename',
  sessionsExportHtml: 'pi-desktop:sessions:export-html',
  sessionsDelete: 'pi-desktop:sessions:delete',
  sessionsMenu: 'pi-desktop:sessions:menu',
  projectsMenu: 'pi-desktop:projects:menu',
  projectsAdd: 'pi-desktop:projects:add',
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
  chatRefresh: 'pi-desktop:chat:refresh',
  chatGetForkMessages: 'pi-desktop:chat:get-fork-messages',
  chatFork: 'pi-desktop:chat:fork',
  chatClone: 'pi-desktop:chat:clone',
  chatIdForSession: 'pi-desktop:chat:id-for-session',
  chatMenu: 'pi-desktop:chat:menu',
  chatRespondUi: 'pi-desktop:chat:respond-ui',
  chatClose: 'pi-desktop:chat:close',
  chatTranscript: 'pi-desktop:chat:transcript',
  chatFocus: 'pi-desktop:chat:focus',
  catalogGet: 'pi-desktop:catalog:get',
  chatReload: 'pi-desktop:chat:reload',
  chatGetTree: 'pi-desktop:chat:get-tree',
  chatLastAssistantText: 'pi-desktop:chat:last-assistant-text',
  sessionsImport: 'pi-desktop:sessions:import',
  sessionsExportFile: 'pi-desktop:sessions:export-file',
  runtimeCommand: 'pi-desktop:runtime:command',
  terminalSpawn: 'pi-desktop:terminal:spawn',
  terminalWrite: 'pi-desktop:terminal:write',
  terminalResize: 'pi-desktop:terminal:resize',
  terminalKill: 'pi-desktop:terminal:kill',
  terminalData: 'pi-desktop:terminal:data',
  terminalExit: 'pi-desktop:terminal:exit',
  browserCreate: 'pi-desktop:browser:create',
  browserNavigate: 'pi-desktop:browser:navigate',
  browserBack: 'pi-desktop:browser:back',
  browserForward: 'pi-desktop:browser:forward',
  browserReloadOrStop: 'pi-desktop:browser:reload-or-stop',
  browserClose: 'pi-desktop:browser:close',
  browserSetVisible: 'pi-desktop:browser:set-visible',
  browserSetOverlay: 'pi-desktop:browser:set-overlay',
  browserState: 'pi-desktop:browser:state',
  browserOpenUrl: 'pi-desktop:browser:open-url',
  browserDownloaded: 'pi-desktop:browser:downloaded',
  browserAgentTab: 'pi-desktop:browser:agent-tab',
  diffStatus: 'pi-desktop:diff:status',
  appQuit: 'pi-desktop:app:quit',
  appOpenExternal: 'pi-desktop:app:open-external'
} as const

export interface IpcDeps {
  pool: PiProcessPool
  chat: ChatService
  pty: PtyManager
  browser: BrowserManager
  /** Loopback bridge server for pi browser tools; stopped on quit. */
  bridge?: { stop(): Promise<void> }
}

/**
 * Map app settings to runtime resolution options. The
 * PI_DESKTOP_PI_COMMAND env override (dev/test) always wins over the
 * configured custom path.
 */
export function runtimeOptionsFromSettings(
  settings: AppSettings,
  envCommand = process.env['PI_DESKTOP_PI_COMMAND']
): { customPath?: string; mode?: 'auto' | 'installed' | 'bundled' | 'custom' } {
  const mode = settings.piRuntime.mode
  return {
    customPath: envCommand || (mode === 'custom' ? settings.piRuntime.customPath : undefined),
    mode: mode === 'custom' ? 'auto' : mode
  }
}

/** Apply the persisted runtime settings to the pool (drops the cached runtime). */
async function applyRuntimeSettings(pool: PiProcessPool): Promise<void> {
  const settings = await loadAppSettings()
  pool.setRuntimeOptions(runtimeOptionsFromSettings(settings))
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

  ipcMain.handle(IPC_CHANNELS.runtimeRefresh, async (): Promise<PiRuntimeInfo> => {
    await applyRuntimeSettings(deps.pool)
    const runtime = await deps.pool.refreshRuntime()
    return { kind: runtime.kind, version: runtime.version, command: basename(runtime.command) }
  })

  ipcMain.handle(IPC_CHANNELS.sessionsList, async () => {
    const [sessions, settings] = await Promise.all([listSessions(), loadAppSettings()])
    const hidden = new Set(settings.hiddenProjects)
    return sessions.filter((s) => !hidden.has(s.cwd))
  })

  ipcMain.handle(IPC_CHANNELS.projectsList, async () => {
    const [sessions, settings] = await Promise.all([listSessions(), loadAppSettings()])
    return mergeProjects(
      sessions,
      settings.projects,
      settings.hiddenProjects,
      workspaceDir()
    )
  })

  ipcMain.handle(IPC_CHANNELS.projectsAdd, async (_e, input: { cwd: string }) => {
    if (typeof input?.cwd !== 'string' || !isAbsolute(input.cwd)) {
      throw new Error('Invalid project cwd')
    }
    const cwd = resolve(input.cwd)
    if (!(await stat(cwd).then((s) => s.isDirectory()).catch(() => false))) {
      throw new Error('Project directory does not exist')
    }
    if (cwd === workspaceDir()) {
      return // the scratch dir is never a project
    }
    const settings = await loadAppSettings()
    if (settings.projects.some((p) => p.cwd === cwd)) {
      return
    }
    await updateAppSettings({
      projects: [...settings.projects, { cwd, addedAt: new Date().toISOString() }]
    })
  })

  ipcMain.handle(IPC_CHANNELS.settingsGet, () => readSettings())

  ipcMain.handle(IPC_CHANNELS.appSettingsGet, () => loadAppSettings())

  ipcMain.handle(IPC_CHANNELS.appSettingsUpdate, async (_e, patch: unknown) => {
    const next = await updateAppSettings(patch)
    if (
      patch !== null &&
      typeof patch === 'object' &&
      'piRuntime' in (patch as Record<string, unknown>)
    ) {
      await applyRuntimeSettings(deps.pool)
    }
    return next
  })

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

  ipcMain.handle(IPC_CHANNELS.appInfo, () => {
    const agentDir = getAgentDir()
    const home = homedir()
    return {
      version: app.getVersion(),
      platform: process.platform,
      agentDir,
      agentDirDisplay:
        home !== '/' && agentDir.startsWith(home)
          ? `~${agentDir.slice(home.length)}`
          : agentDir,
      workspaceDir: workspaceDir()
    }
  })

  ipcMain.handle(IPC_CHANNELS.appOpenAgentDir, () => shell.openPath(getAgentDir()))

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
  ipcMain.handle(
    IPC_CHANNELS.chatRefresh,
    (_e, input: { chatId: string }) => deps.chat.refresh(input)
  )
  ipcMain.handle(IPC_CHANNELS.chatGetForkMessages, (_e, input: { chatId: string }) =>
    deps.chat.getForkMessages(input)
  )
  ipcMain.handle(
    IPC_CHANNELS.chatFork,
    (_e, input: { chatId: string; entryId: string }) => deps.chat.fork(input)
  )
  ipcMain.handle(IPC_CHANNELS.chatClone, (_e, input: { chatId: string }) =>
    deps.chat.clone(input)
  )
  ipcMain.handle(IPC_CHANNELS.chatIdForSession, (_e, input: { sessionPath: string }) =>
    deps.chat.chatIdForSession(validateSessionPath(input.sessionPath))
  )
  ipcMain.handle(IPC_CHANNELS.chatClose, (_e, input: { chatId: string }) => deps.chat.close(input))

  ipcMain.handle(
    IPC_CHANNELS.chatTranscript,
    (_e, input: { sessionPath: string; limit?: number }) => {
      const sessionPath = validateSessionPath(input.sessionPath)
      const limit =
        typeof input?.limit === 'number' && Number.isFinite(input.limit)
          ? Math.min(Math.max(Math.floor(input.limit), 1), 20_000)
          : undefined
      return readSessionTranscript(sessionPath, { ...(limit ? { limit } : {}) })
    }
  )

  ipcMain.handle(IPC_CHANNELS.chatFocus, (_e, input: { chatId: string }) => {
    deps.chat.markFocused(validateChatId(input.chatId))
  })

  ipcMain.handle(IPC_CHANNELS.catalogGet, async () => {
    return (
      (await getCatalogCache()) ?? {
        models: [],
        commands: [],
        thinkingLevels: [],
        model: null,
        thinkingLevel: null
      }
    )
  })

  ipcMain.handle(
    IPC_CHANNELS.sessionsRename,
    (_e, input: { sessionPath: string; name: string }) => deps.chat.renameSession(input)
  )
  ipcMain.handle(
    IPC_CHANNELS.sessionsExportHtml,
    (_e, input: { sessionPath: string; outputPath: string }) =>
      deps.chat.exportSession(input)
  )
  ipcMain.handle(IPC_CHANNELS.sessionsDelete, async (_e, input: { sessionPath: string }) => {
    const sessionPath = validateSessionPath(input.sessionPath)
    await deps.chat.closeChatForSession(sessionPath)
    await shell.trashItem(sessionPath)
  })

  ipcMain.handle(
    IPC_CHANNELS.sessionsMenu,
    (event, input: { sessionPath: string }): Promise<SessionMenuAction | null> => {
      validateSessionPath(input.sessionPath)
      return popupMenu<SessionMenuAction>(event, [
        { id: 'rename', label: 'Rename…' },
        { id: 'export', label: 'Export as HTML…' },
        { id: 'reveal', label: 'Reveal in Finder' },
        { id: 'copy-path', label: 'Copy Session Path' },
        { type: 'separator' },
        { id: 'delete', label: 'Move to Trash…' }
      ])
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.projectsMenu,
    (event, input: { cwd: string }): Promise<ProjectMenuAction | null> => {
      if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) {
        throw new Error('Invalid cwd')
      }
      return popupMenu<ProjectMenuAction>(event, [
        { id: 'reveal', label: 'Reveal in Finder' },
        { id: 'new-chat', label: 'New Chat in This Project' },
        { type: 'separator' },
        { id: 'hide', label: 'Hide from List' }
      ])
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.chatMenu,
    (event, input: { chatId: string }): Promise<ChatMenuAction | null> => {
      validateChatId(input.chatId)
      return popupMenu<ChatMenuAction>(event, [
        { id: 'rename', label: 'Rename…' },
        { id: 'export', label: 'Export as HTML…' },
        { id: 'clone', label: 'Fork Chat' },
        { id: 'reveal', label: 'Reveal in Finder' },
        { type: 'separator' },
        { id: 'delete', label: 'Move to Trash…' }
      ])
    }
  )

  ipcMain.handle(IPC_CHANNELS.chatReload, (_e, input: { chatId: string }) =>
    deps.chat.reload(input)
  )
  ipcMain.handle(IPC_CHANNELS.chatGetTree, (_e, input: { chatId: string }) =>
    deps.chat.getTree(input)
  )
  ipcMain.handle(IPC_CHANNELS.chatLastAssistantText, (_e, input: { chatId: string }) =>
    deps.chat.getLastAssistantText(input)
  )

  ipcMain.handle(IPC_CHANNELS.sessionsImport, async (_e, input: { path: string }) => {
    if (typeof input?.path !== 'string' || !isAbsolute(input.path)) {
      throw new Error('Invalid import path')
    }
    return importSessionFile(input.path)
  })

  ipcMain.handle(
    IPC_CHANNELS.sessionsExportFile,
    async (_e, input: { sessionPath: string; outputPath: string }) => {
      const sessionPath = validateSessionPath(input.sessionPath)
      if (typeof input?.outputPath !== 'string' || !isAbsolute(input.outputPath)) {
        throw new Error('Invalid output path')
      }
      if (input.outputPath.endsWith('.jsonl')) {
        await copyFile(sessionPath, input.outputPath)
        return { path: input.outputPath }
      }
      return deps.chat.exportSession(input)
    }
  )

  ipcMain.handle(IPC_CHANNELS.runtimeCommand, async () => {
    const runtime = await deps.pool.getRuntime()
    return { command: runtime.command, args: runtime.args }
  })

  ipcMain.handle(IPC_CHANNELS.terminalSpawn, async (_e, input: TerminalSpawnInput) => {
    if (typeof input?.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.id)) {
      throw new Error('Invalid terminal id')
    }
    const cwd = await validateCwd(input.cwd)
    const argv =
      input.argv === undefined
        ? undefined
        : (() => {
            if (
              !Array.isArray(input.argv) ||
              input.argv.length === 0 ||
              input.argv.length > 64 ||
              !input.argv.every((a) => typeof a === 'string' && a.length < 4096)
            ) {
              throw new Error('Invalid terminal argv')
            }
            return input.argv
          })()
    const profile = input.profile === 'pi' ? 'pi' : 'shell'
    const env =
      profile === 'pi'
        ? { ...(await loginShellEnv()), ...(await deps.pool.getRuntime()).env }
        : await loginShellEnv()
    return deps.pty.spawn({
      id: input.id,
      cwd,
      argv,
      env,
      initialInput:
        typeof input.initialInput === 'string' && input.initialInput.length < 4096
          ? input.initialInput
          : undefined,
      cols: input.cols,
      rows: input.rows
    })
  })
  ipcMain.handle(IPC_CHANNELS.terminalWrite, (_e, input: { id: string; data: string }) => {
    if (typeof input?.id !== 'string' || typeof input.data !== 'string') {
      throw new Error('Invalid terminal write')
    }
    deps.pty.write(input.id, input.data)
  })
  ipcMain.handle(
    IPC_CHANNELS.terminalResize,
    (_e, input: { id: string; cols: number; rows: number }) => {
      if (typeof input?.id !== 'string') {
        throw new Error('Invalid terminal resize')
      }
      deps.pty.resize(input.id, input.cols, input.rows)
    }
  )
  ipcMain.handle(IPC_CHANNELS.terminalKill, (_e, input: { id: string }) => {
    if (typeof input?.id !== 'string') {
      throw new Error('Invalid terminal id')
    }
    return deps.pty.kill(input.id)
  })

  const browserId = (value: unknown): string => {
    // Agent-owned tabs are 'agent-<chatId>', so allow a little headroom.
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
      throw new Error('Invalid browser tab id')
    }
    return value
  }

  ipcMain.handle(IPC_CHANNELS.browserCreate, (_e, input: { id: string; url?: string }) =>
    deps.browser.create(browserId(input?.id), typeof input?.url === 'string' ? input.url : undefined)
  )
  ipcMain.handle(IPC_CHANNELS.browserNavigate, (_e, input: { id: string; url: string }) => {
    if (typeof input?.url !== 'string' || input.url.length > 4096) {
      throw new Error('Invalid URL')
    }
    deps.browser.navigate(browserId(input.id), input.url)
  })
  ipcMain.handle(IPC_CHANNELS.browserBack, (_e, input: { id: string }) =>
    deps.browser.goBack(browserId(input?.id))
  )
  ipcMain.handle(IPC_CHANNELS.browserForward, (_e, input: { id: string }) =>
    deps.browser.goForward(browserId(input?.id))
  )
  ipcMain.handle(IPC_CHANNELS.browserReloadOrStop, (_e, input: { id: string }) =>
    deps.browser.reloadOrStop(browserId(input?.id))
  )
  ipcMain.handle(IPC_CHANNELS.browserClose, (_e, input: { id: string }) =>
    deps.browser.close(browserId(input?.id))
  )
  ipcMain.handle(
    IPC_CHANNELS.browserSetVisible,
    (_e, input: { id: string | null; rect?: BrowserRect }) => {
      deps.browser.setVisible(
        input?.id === null ? null : browserId(input?.id),
        input?.rect && typeof input.rect === 'object' ? input.rect : undefined
      )
    }
  )
  ipcMain.handle(IPC_CHANNELS.browserSetOverlay, (_e, input: { open: boolean }) =>
    deps.browser.setOverlayOpen(input?.open === true)
  )

  ipcMain.handle(IPC_CHANNELS.diffStatus, (_e, input: { cwd: string }) =>
    validateCwd(input?.cwd).then((cwd) => getRepoDiff(cwd))
  )

  ipcMain.handle(IPC_CHANNELS.appQuit, () => {
    app.quit()
  })

  ipcMain.handle(IPC_CHANNELS.appOpenExternal, (_e, url: string) => {
    if (
      typeof url !== 'string' ||
      url.length > 2048 ||
      (!/^https:\/\//.test(url) && !/^http:\/\/localhost(:\d+)?(\/|$)/.test(url))
    ) {
      throw new Error('Only https:// (or http://localhost) URLs can be opened externally')
    }
    return shell.openExternal(url)
  })
}

/** Dispatch a native-menu action to the focused renderer window. */
export function sendMenuAction(action: MenuAction): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IPC_CHANNELS.menuAction, action)
}

type MenuItem = { id: string; label: string } | { type: 'separator' }

/** Show a native context menu and resolve to the clicked item id (or null). */
function popupMenu<A extends string>(
  event: Electron.IpcMainInvokeEvent,
  items: MenuItem[]
): Promise<A | null> {
  return new Promise((resolvePromise) => {
    let selected: A | null = null
    const menu = Menu.buildFromTemplate(
      items.map((item) =>
        'id' in item
          ? {
              label: item.label,
              click: () => {
                selected = item.id as A
              }
            }
          : { type: 'separator' as const }
      )
    )
    menu.popup({
      window: BrowserWindow.fromWebContents(event.sender) ?? undefined,
      callback: () => resolvePromise(selected)
    })
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
    void deps.chat.closeAll()
    void deps.pty.killAll()
    deps.browser.closeAll()
    void deps.bridge?.stop()
  })
}

/** Send a channel message to all open windows. */
export function broadcastAll(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export { CHAT_CHANNELS }
