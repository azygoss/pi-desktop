import { basename, delimiter, isAbsolute, join, resolve } from 'node:path'
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir, tmpdir, userInfo } from 'node:os'
import { BrowserWindow, Menu, Notification, app, clipboard, dialog, ipcMain, nativeTheme, shell, systemPreferences } from 'electron'
import QRCode from 'qrcode'
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
import type { AgentMessage, ThinkingLevel } from '../shared/pi-types'
import type { PiProcessPool } from './pi/pool'
import { CHAT_CHANNELS, ChatService } from './chat/chat-service'
import { validateChatId, validateCwd, validateSessionPath } from './chat/validation'
import { loadAppSettings, updateAppSettings } from './config/app-settings'
import { listLocalServers, type LocalServer } from './local-servers'
import { appUserDataDir, workspaceDir, worktreesDir } from './config/app-paths'
import { commitAll, discardFile, pushBranch } from './git/git-actions'
import {
  createWorktree,
  isAppWorktree,
  removeWorktree,
  worktreeDisplayName
} from './git/worktrees'
import { readProjectFile, readProjectImage } from './files/read-file'
import { saveUpload } from './files/upload'
import { usageReport } from './sessions/usage'
import type { Automation } from '../shared/automations'
import {
  deleteAutomation,
  listAutomations,
  markAutomationRun,
  saveAutomation,
  setAutomationSession
} from './automations/automation-store'
import { getFailedLog, getPrStatus } from './git/pr-status'
import { createCheckpoint, restoreCheckpoint } from './git/checkpoints'
import type { SideChatService } from './chat/side-service'
import { REVIEW_PROMPT, parseReviewComments } from '../shared/review'
import { readSettings } from './config/settings'
import { loginShellEnv } from './pi/locator'
import { APP_BUNDLE_ID } from './cua/cua-tools'
import { BrowserManager } from './browser/browser-manager'
import { getRepoDiff, getRepoSummary } from './diff/git-diff'
import { listOpenTargets, openInTarget } from './open-in'
import { importSessionFile } from './sessions/import-session'
import { getAgentDir } from './sessions/paths'
import {
  getSessionMeta,
  removeSessionMeta,
  setSessionMeta
} from './sessions/session-meta'
import { listSessions, watchSessions } from './sessions/session-index'
import { readSessionTranscript } from './sessions/transcript'
import { searchSessions } from './sessions/session-search'
import { getCatalogCache } from './config/catalog-cache'
import { mergeProjects } from './sessions/projects'
import { PtyManager } from './terminal/pty-manager'
import { listProjectFiles } from './files/file-list'
import { readAttachments } from './files/attachments'
import { REMOTE_CHANNELS } from '../shared/remote/protocol'
import { SIDE_CHANNELS } from './chat/side-service'
import { ReviewCommentStore } from './review/comment-store'
import { listDirs } from './remote/list-dirs'
import { trimTranscript } from './remote/trim-transcript'
import type { RemoteStatus } from './remote/remote-server'

export const IPC_CHANNELS = {
  runtimeInfo: 'pi-desktop:runtime:info',
  sessionsList: 'pi-desktop:sessions:list',
  sessionsSearch: 'pi-desktop:sessions:search',
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
  /** Broadcast: settings changed outside this window (from a paired phone). */
  appSettingsChanged: 'pi-desktop:app-settings:changed',
  sessionsChanged: 'pi-desktop:sessions:changed',
  sessionsRename: 'pi-desktop:sessions:rename',
  sessionsExportHtml: 'pi-desktop:sessions:export-html',
  sessionsDelete: 'pi-desktop:sessions:delete',
  sessionsMenu: 'pi-desktop:sessions:menu',
  sessionMetaGet: 'pi-desktop:session-meta:get',
  sessionMetaSet: 'pi-desktop:session-meta:set',
  sessionMetaChanged: 'pi-desktop:session-meta:changed',
  filesList: 'pi-desktop:files:list',
  filesReadAttachments: 'pi-desktop:files:read-attachments',
  dialogPickFiles: 'pi-desktop:dialog:pick-files',
  projectsMenu: 'pi-desktop:projects:menu',
  projectsAdd: 'pi-desktop:projects:add',
  chatOpen: 'pi-desktop:chat:open',
  chatSend: 'pi-desktop:chat:send',
  chatAbort: 'pi-desktop:chat:abort',
  chatBash: 'pi-desktop:chat:bash',
  chatAbortBash: 'pi-desktop:chat:abort-bash',
  chatClearQueue: 'pi-desktop:chat:clear-queue',
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
  chatWarm: 'pi-desktop:chat:warm',
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
  diffSummary: 'pi-desktop:diff:summary',
  automationsList: 'pi-desktop:automations:list',
  automationsSave: 'pi-desktop:automations:save',
  automationsDelete: 'pi-desktop:automations:delete',
  automationsRunNow: 'pi-desktop:automations:run-now',
  automationsSetSession: 'pi-desktop:automations:set-session',
  /** Broadcast: a window should start this automation's run. */
  automationsRun: 'pi-desktop:automations:run',
  automationsChanged: 'pi-desktop:automations:changed',
  prStatus: 'pi-desktop:pr:status',
  prFailedLog: 'pi-desktop:pr:failed-log',
  diffReview: 'pi-desktop:diff:review',
  checkpointsCreate: 'pi-desktop:checkpoints:create',
  checkpointsRestore: 'pi-desktop:checkpoints:restore',
  sideOpen: 'pi-desktop:side:open',
  sideSend: 'pi-desktop:side:send',
  sideAbort: 'pi-desktop:side:abort',
  sideClose: 'pi-desktop:side:close',
  diffDiscard: 'pi-desktop:diff:discard',
  diffCommit: 'pi-desktop:diff:commit',
  reviewCommentsList: 'pi-desktop:review-comments:list',
  reviewCommentsAdd: 'pi-desktop:review-comments:add',
  reviewCommentsRemove: 'pi-desktop:review-comments:remove',
  reviewCommentsClear: 'pi-desktop:review-comments:clear',
  reviewCommentsChanged: 'pi-desktop:review-comments:changed',
  diffPush: 'pi-desktop:diff:push',
  filesRead: 'pi-desktop:files:read',
  sessionsUsage: 'pi-desktop:sessions:usage',
  projectsCreateWorktree: 'pi-desktop:projects:create-worktree',
  projectsRemoveWorktree: 'pi-desktop:projects:remove-worktree',
  appOpenInMenu: 'pi-desktop:app:open-in-menu',
  appQuit: 'pi-desktop:app:quit',
  appOpenExternal: 'pi-desktop:app:open-external',
  appLocalServers: 'pi-desktop:app:local-servers',
  appNotify: 'pi-desktop:app:notify',
  appSetBadge: 'pi-desktop:app:set-badge',
  /** Broadcast to the renderer when a notification click should open a chat. */
  appOpenChat: 'pi-desktop:app:open-chat',
  cuaPermissions: 'pi-desktop:cua:permissions',
  cuaRequestPermissions: 'pi-desktop:cua:request-permissions',
  cuaOpenSettings: 'pi-desktop:cua:open-settings',
  cuaResetPermissions: 'pi-desktop:cua:reset-permissions',
  cuaPause: 'pi-desktop:cua:pause',
  cuaResume: 'pi-desktop:cua:resume',
  cuaStop: 'pi-desktop:cua:stop',
  cuaActivity: 'pi-desktop:cua:activity',
  /** e2e-only: inject a fake cua:activity broadcast (PI_DESKTOP_E2E=1). */
  cuaTestActivity: 'pi-desktop:cua:test-activity',
  updatesGet: 'pi-desktop:updates:get',
  updatesCheckNow: 'pi-desktop:updates:check-now',
  updatesOpen: 'pi-desktop:updates:open',
  /** Broadcast when the release check finds a newer version. */
  appUpdateAvailable: 'pi-desktop:app:update-available',
  dictationPermissions: 'pi-desktop:dictation:permissions',
  dictationLocales: 'pi-desktop:dictation:locales',
  dictationStart: 'pi-desktop:dictation:start',
  dictationStop: 'pi-desktop:dictation:stop',
  dictationCancel: 'pi-desktop:dictation:cancel',
  dictationOpenSettings: 'pi-desktop:dictation:open-settings',
  dictationEvent: 'pi-desktop:dictation:event',
  /** e2e-only: inject a fake dictation event (PI_DESKTOP_E2E=1). */
  dictationTestEvent: 'pi-desktop:dictation:test-event',
  remoteStatus: 'pi-desktop:remote:status',
  remoteBeginPairing: 'pi-desktop:remote:begin-pairing',
  remoteCancelPairing: 'pi-desktop:remote:cancel-pairing',
  remoteRevoke: 'pi-desktop:remote:revoke',
  /** Broadcast to windows when devices, connections or pairing change. */
  remoteChanged: 'pi-desktop:remote:changed'
} as const

type IpcHandler = (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown

/** Every registered handler by channel, so a paired phone can run them too. */
const handlers = new Map<string, IpcHandler>()

function handle(channel: string, handler: IpcHandler): void {
  handlers.set(channel, handler)
  ipcMain.handle(channel, handler as Parameters<typeof ipcMain.handle>[1])
}

/**
 * Channels a paired phone may invoke. Left out on purpose: anything that
 * opens a native dialog or menu on the computer, the terminal and browser
 * panels, dictation, app settings, quitting, and remote-control management
 * itself (a phone cannot pair another phone).
 */
const REMOTE_ALLOWED: ReadonlySet<string> = new Set([
  IPC_CHANNELS.runtimeInfo,
  IPC_CHANNELS.sessionsList,
  IPC_CHANNELS.sessionsSearch,
  IPC_CHANNELS.sessionsUsage,
  IPC_CHANNELS.sessionsRename,
  IPC_CHANNELS.sessionsDelete,
  IPC_CHANNELS.sessionMetaGet,
  IPC_CHANNELS.sessionMetaSet,
  IPC_CHANNELS.projectsList,
  IPC_CHANNELS.projectsAdd,
  IPC_CHANNELS.projectsCreateWorktree,
  IPC_CHANNELS.projectsRemoveWorktree,
  IPC_CHANNELS.settingsGet,
  IPC_CHANNELS.appSettingsGet,
  IPC_CHANNELS.appUserFirstName,
  IPC_CHANNELS.appInfo,
  IPC_CHANNELS.catalogGet,
  IPC_CHANNELS.filesList,
  IPC_CHANNELS.filesRead,
  IPC_CHANNELS.chatOpen,
  IPC_CHANNELS.chatSend,
  IPC_CHANNELS.chatAbort,
  IPC_CHANNELS.chatBash,
  IPC_CHANNELS.chatAbortBash,
  IPC_CHANNELS.chatClearQueue,
  IPC_CHANNELS.chatSetModel,
  IPC_CHANNELS.chatSetThinkingLevel,
  IPC_CHANNELS.chatGetStats,
  IPC_CHANNELS.chatSetCwd,
  IPC_CHANNELS.chatCompact,
  IPC_CHANNELS.chatSetSessionName,
  IPC_CHANNELS.chatRefresh,
  IPC_CHANNELS.chatGetForkMessages,
  IPC_CHANNELS.chatFork,
  IPC_CHANNELS.chatClone,
  IPC_CHANNELS.chatIdForSession,
  IPC_CHANNELS.chatRespondUi,
  IPC_CHANNELS.chatTranscript,
  IPC_CHANNELS.chatReload,
  IPC_CHANNELS.chatGetTree,
  IPC_CHANNELS.chatLastAssistantText,
  IPC_CHANNELS.checkpointsCreate,
  IPC_CHANNELS.checkpointsRestore,
  IPC_CHANNELS.sideOpen,
  IPC_CHANNELS.sideSend,
  IPC_CHANNELS.sideAbort,
  IPC_CHANNELS.sideClose,
  IPC_CHANNELS.diffStatus,
  IPC_CHANNELS.diffSummary,
  IPC_CHANNELS.diffDiscard,
  IPC_CHANNELS.diffCommit,
  IPC_CHANNELS.diffPush,
  IPC_CHANNELS.diffReview,
  IPC_CHANNELS.reviewCommentsList,
  IPC_CHANNELS.reviewCommentsAdd,
  IPC_CHANNELS.reviewCommentsRemove,
  IPC_CHANNELS.reviewCommentsClear,
  IPC_CHANNELS.prStatus,
  IPC_CHANNELS.prFailedLog,
  IPC_CHANNELS.automationsList,
  IPC_CHANNELS.automationsSave,
  IPC_CHANNELS.automationsDelete,
  IPC_CHANNELS.automationsRunNow,
  IPC_CHANNELS.cuaPermissions,
  IPC_CHANNELS.cuaPause,
  IPC_CHANNELS.cuaResume,
  IPC_CHANNELS.cuaStop,
  REMOTE_CHANNELS.liveChats,
  REMOTE_CHANNELS.listDirs,
  REMOTE_CHANNELS.setComputerUse,
  REMOTE_CHANNELS.exportHtml,
  REMOTE_CHANNELS.upload,
  REMOTE_CHANNELS.readImage
])

/** Broadcasts a paired phone receives (chat events are filtered per chat). */
export const REMOTE_FORWARD = {
  chatEvents: CHAT_CHANNELS.event,
  channels: new Set<string>([
    CHAT_CHANNELS.uiRequest,
    CHAT_CHANNELS.uiResolved,
    CHAT_CHANNELS.exit,
    CHAT_CHANNELS.ready,
    CHAT_CHANNELS.hint,
    SIDE_CHANNELS.event,
    SIDE_CHANNELS.exit,
    IPC_CHANNELS.sessionsChanged,
    IPC_CHANNELS.sessionMetaChanged,
    IPC_CHANNELS.automationsChanged,
    IPC_CHANNELS.reviewCommentsChanged,
    IPC_CHANNELS.cuaActivity
  ]) as ReadonlySet<string>
}

/** Side chats opened by paired phones: side id → device id. */
const remoteSides = new Map<string, string>()

/** Close the side chats a phone left open (it is gone, or was removed). */
export function closeRemoteSides(deviceId: string): void {
  const close = handlers.get(IPC_CHANNELS.sideClose) as
    | ((event: null, input: unknown) => unknown)
    | undefined
  for (const [sideId, owner] of remoteSides) {
    if (owner === deviceId) {
      remoteSides.delete(sideId)
      void Promise.resolve(close?.(null, { sideId })).catch(() => {})
    }
  }
}

let remoteSink: ((channel: string, payload: unknown) => void) | null = null
let remoteTouch: ((chatId: string) => void) | null = null

/** Route every broadcast to the remote-control host as well. */
export function setRemoteSink(sink: ((channel: string, payload: unknown) => void) | null): void {
  remoteSink = sink
}

/**
 * Run an IPC handler for a paired phone. Only allowlisted channels exist
 * here, and none of them reads the sender, so the handler runs without one.
 * `lite: true` in the input drops the message list from catalog results:
 * the phone renders long transcripts from the session file in pages.
 */
export async function invokeRemote(
  channel: string,
  arg: unknown,
  deviceId = ''
): Promise<unknown> {
  const handler = REMOTE_ALLOWED.has(channel) ? handlers.get(channel) : undefined
  if (!handler) {
    throw new Error('Not available from a paired device')
  }
  const input = arg !== null && typeof arg === 'object' ? (arg as Record<string, unknown>) : null
  if (typeof input?.['chatId'] === 'string') {
    remoteTouch?.(input['chatId'])
  }
  // Side chats are short-lived pi processes: remember whose they are, so
  // they can be closed if that phone never comes back. Recorded before the
  // open (pi can take a while to start), not after it.
  const sideId = typeof input?.['sideId'] === 'string' ? input['sideId'] : undefined
  const opensSide = sideId !== undefined && channel === IPC_CHANNELS.sideOpen
  if (opensSide) {
    remoteSides.set(sideId, deviceId)
  }
  const run = handler as unknown as (event: null, input: unknown) => unknown
  let result: unknown
  try {
    result = await run(null, arg)
  } catch (error) {
    if (opensSide) {
      remoteSides.delete(sideId)
    }
    throw error
  }
  if (opensSide && !remoteSides.has(sideId)) {
    // The phone was given up on while pi was starting: nobody owns this one.
    const close = handlers.get(IPC_CHANNELS.sideClose) as typeof run | undefined
    void Promise.resolve(close?.(null, { sideId })).catch(() => {})
  } else if (sideId !== undefined && channel === IPC_CHANNELS.sideClose) {
    remoteSides.delete(sideId)
  }
  if (
    result !== null &&
    typeof result === 'object' &&
    Array.isArray((result as { messages?: unknown }).messages)
  ) {
    // The transcript the phone pages through: long tool output is cut.
    if (channel === IPC_CHANNELS.chatTranscript) {
      const transcript = result as { messages: AgentMessage[] }
      return { ...transcript, messages: trimTranscript(transcript.messages) }
    }
    if (input?.['lite'] === true) {
      return { ...result, messages: [] }
    }
  }
  return result
}

export interface IpcDeps {
  pool: PiProcessPool
  chat: ChatService
  pty: PtyManager
  browser: BrowserManager
  /** Loopback bridge server for pi browser tools; stopped on quit. */
  bridge?: { stop(): Promise<void>; url?: string }
  /** Computer-use helper service; absent on non-macOS/test setups. */
  cua?: {
    available(): boolean
    call(cmd: string, args?: Record<string, unknown>): Promise<unknown>
    pause(): void
    resume(): void
    abortAll(message?: string): void
    dispose(): void
    /** Stop an idle helper so the next call sees fresh permissions. */
    recycle(): void
  }
  /** Release update checker; absent in unit-test setups. */
  updates?: {
    readonly current: { version: string; url: string } | null
    checkNow(): Promise<
      | { status: 'update-available'; version: string; url: string }
      | { status: 'up-to-date' }
      | { status: 'unavailable' }
    >
  }
  /** Side chats and one-shot asks; absent in unit-test setups. */
  side?: SideChatService
  /** Automation scheduler; absent in unit-test setups. */
  automations?: {
    /** The list changed — re-aim the timer. */
    refresh(): void
    /** Start the run; false when it could not start (no window). */
    trigger(automation: Automation): boolean | Promise<boolean>
  }
  /** Remote-control host for paired phones; absent in unit-test setups. */
  remote?: {
    /** Start or stop the host to match the setting. */
    apply(enabled: boolean): Promise<void>
    /** Read the stored pairings, if there are any, without starting the host. */
    loadDevices(): Promise<void>
    status(): RemoteStatus
    beginPairing(): { payload: string; expiresAt: number }
    cancelPairing(): void
    revoke(deviceId: string): Promise<void>
  }
  /** Dictation helper service; absent on non-macOS/test setups. */
  dictation?: {
    available(): boolean
    call(cmd: string, args?: Record<string, unknown>): Promise<unknown>
    start(args: { locale?: string; autoStop?: boolean }): Promise<void>
    stop(): Promise<void>
    cancel(): Promise<void>
    dispose(): void
  }
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
 * Best-effort first name for the sidebar footer: on macOS `id -F` returns the
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
  remoteTouch = (chatId) => deps.chat.touch(chatId)

  // --- Remote control -----------------------------------------------------

  const remoteOff: RemoteStatus = {
    running: false,
    port: null,
    addresses: [],
    devices: [],
    pairingExpiresAt: null
  }
  handle(IPC_CHANNELS.remoteStatus, async () => {
    // Paired phones are listed (and can be removed) while the host is off.
    await deps.remote?.loadDevices().catch(() => {})
    return deps.remote?.status() ?? remoteOff
  })
  handle(IPC_CHANNELS.remoteBeginPairing, async () => {
    if (!deps.remote) {
      throw new Error('Remote control is not available')
    }
    // Asking for a code is asking for remote control: turn it on first.
    if (!(await loadAppSettings()).remote.enabled) {
      await updateAppSettings({ remote: { enabled: true } })
    }
    await deps.remote.apply(true)
    const code = deps.remote.beginPairing()
    const qr = QRCode.create(code.payload, { errorCorrectionLevel: 'M' })
    return { ...code, size: qr.modules.size, modules: Array.from(qr.modules.data) }
  })
  handle(IPC_CHANNELS.remoteCancelPairing, () => deps.remote?.cancelPairing())
  handle(IPC_CHANNELS.remoteRevoke, async (_e, input: { deviceId?: unknown }) => {
    if (typeof input?.deviceId !== 'string' || input.deviceId.length > 64) {
      throw new Error('Invalid device')
    }
    await deps.remote?.loadDevices().catch(() => {})
    await deps.remote?.revoke(input.deviceId)
  })
  handle(REMOTE_CHANNELS.liveChats, () => deps.chat.listLive())
  handle(REMOTE_CHANNELS.setComputerUse, async (_e, input: { enabled?: unknown }) => {
    if (typeof input?.enabled !== 'boolean') {
      throw new Error('Invalid value')
    }
    const next = await updateAppSettings({ computerUse: { enabled: input.enabled } })
    // Baked into each pi's spawn env: spares are respawned, and a chat
    // picks it up when it is next started (as from the desktop composer).
    void deps.chat.resetSpares().catch(() => {})
    broadcastAll(IPC_CHANNELS.appSettingsChanged, next)
    return { enabled: next.computerUse.enabled }
  })
  handle(REMOTE_CHANNELS.exportHtml, async (_e, input: { sessionPath?: unknown }) => {
    const sessionPath = validateSessionPath(input?.sessionPath)
    const dir = await mkdtemp(join(tmpdir(), 'pi-desktop-export-'))
    try {
      const outputPath = join(dir, 'session.html')
      await deps.chat.exportSession({ sessionPath, outputPath })
      // Only the file asked for, never a path pi reports back.
      const html = await readFile(outputPath, 'utf8')
      return { html }
    } finally {
      // Our own scratch file, never user data.
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
  handle(REMOTE_CHANNELS.upload, (_e, input: { name?: unknown; data?: unknown }) =>
    saveUpload(join(appUserDataDir(), 'uploads'), input?.name, input?.data)
  )
  handle(REMOTE_CHANNELS.readImage, async (_e, input: { cwd?: unknown; path?: unknown }) => {
    const cwd = await validateCwd(input?.cwd)
    return readProjectImage(cwd, input?.path, [getAgentDir()])
  })
  handle(REMOTE_CHANNELS.listDirs, (_e, input: { path?: unknown }) =>
    // The pi agent dir holds credentials; the app never reads inside it.
    listDirs(input?.path, [getAgentDir()])
  )

  handle(IPC_CHANNELS.runtimeInfo, async (): Promise<PiRuntimeInfo> => {
    const runtime = await deps.pool.getRuntime()
    return { kind: runtime.kind, version: runtime.version, command: basename(runtime.command) }
  })

  handle(IPC_CHANNELS.runtimeRefresh, async (): Promise<PiRuntimeInfo> => {
    await applyRuntimeSettings(deps.pool)
    const runtime = await deps.pool.refreshRuntime()
    return { kind: runtime.kind, version: runtime.version, command: basename(runtime.command) }
  })

  handle(IPC_CHANNELS.sessionsList, async () => {
    const [sessions, settings] = await Promise.all([listSessions(), loadAppSettings()])
    const hidden = new Set(settings.hiddenProjects)
    return sessions.filter((s) => !hidden.has(s.cwd))
  })

  handle(IPC_CHANNELS.sessionsSearch, async (_e, input: { query?: unknown }) => {
    const query = typeof input?.query === 'string' ? input.query.slice(0, 200) : ''
    const [sessions, settings] = await Promise.all([listSessions(), loadAppSettings()])
    const hidden = new Set(settings.hiddenProjects)
    return searchSessions(
      sessions.filter((s) => !hidden.has(s.cwd)).map((s) => s.path),
      query
    )
  })

  handle(IPC_CHANNELS.projectsList, async () => {
    const [sessions, settings] = await Promise.all([listSessions(), loadAppSettings()])
    const base = worktreesDir()
    // Worktrees the app created read as "repo · slug", not a bare slug.
    return mergeProjects(sessions, settings.projects, settings.hiddenProjects, workspaceDir()).map(
      (project) =>
        isAppWorktree(project.cwd, base)
          ? { ...project, name: worktreeDisplayName(project.cwd), worktree: true }
          : project
    )
  })

  handle(IPC_CHANNELS.projectsCreateWorktree, async (_e, input: { cwd: string }) => {
    const cwd = await validateCwd(input?.cwd)
    const worktree = await createWorktree(cwd, worktreesDir())
    // Listed right away, before its first chat has a session file.
    const settings = await loadAppSettings()
    if (!settings.projects.some((p) => p.cwd === worktree.cwd)) {
      await updateAppSettings({
        projects: [...settings.projects, { cwd: worktree.cwd, addedAt: new Date().toISOString() }]
      })
    }
    return worktree
  })

  handle(
    IPC_CHANNELS.projectsRemoveWorktree,
    async (_e, input: { cwd: string; force?: unknown }) => {
      const cwd = await validateCwd(input?.cwd)
      const result = await removeWorktree(cwd, worktreesDir(), input?.force === true)
      if (result.ok) {
        const settings = await loadAppSettings()
        await updateAppSettings({
          projects: settings.projects.filter((p) => p.cwd !== cwd),
          expandedProjects: settings.expandedProjects.filter((c) => c !== cwd)
        })
      }
      return result
    }
  )

  handle(IPC_CHANNELS.sessionsUsage, async () => {
    const sessions = await listSessions()
    return usageReport(sessions.map((s) => s.path))
  })

  handle(IPC_CHANNELS.filesRead, async (_e, input: { cwd: string; path: unknown }) => {
    const cwd = await validateCwd(input?.cwd)
    // The pi agent dir holds credentials; the app never reads them.
    return readProjectFile(cwd, input?.path, [getAgentDir()])
  })

  // --- Checkpoints, side chats, review ----------------------------------------

  handle(IPC_CHANNELS.checkpointsCreate, async (_e, input: { cwd: string }) =>
    createCheckpoint(await validateCwd(input?.cwd))
  )
  handle(
    IPC_CHANNELS.checkpointsRestore,
    async (_e, input: { cwd: string; checkpoint?: unknown }) =>
      restoreCheckpoint(await validateCwd(input?.cwd), input?.checkpoint, (absolute) =>
        shell.trashItem(absolute)
      )
  )
  const requireSide = (): SideChatService => {
    if (!deps.side) {
      throw new Error('Side chats are not available')
    }
    return deps.side
  }
  handle(IPC_CHANNELS.sideOpen, (_e, input: Record<string, unknown>) =>
    requireSide().open({
      sideId: input?.['sideId'],
      cwd: input?.['cwd'],
      ...(input?.['sessionPath'] !== undefined ? { sessionPath: input['sessionPath'] } : {}),
      model: input?.['model']
    })
  )
  handle(IPC_CHANNELS.sideSend, (_e, input: Record<string, unknown>) =>
    requireSide().send({ sideId: input?.['sideId'], message: input?.['message'] })
  )
  handle(IPC_CHANNELS.sideAbort, (_e, input: Record<string, unknown>) =>
    requireSide().abort({ sideId: input?.['sideId'] })
  )
  handle(IPC_CHANNELS.sideClose, (_e, input: Record<string, unknown>) =>
    requireSide().close({ sideId: input?.['sideId'] })
  )
  // Diff comments live here, per project, so every window and paired phone
  // sees the same list (and a review pass lands even if its screen closed).
  const reviewComments = new ReviewCommentStore(
    join(appUserDataDir(), 'review-comments.json'),
    (cwd, comments) => broadcastAll(IPC_CHANNELS.reviewCommentsChanged, { cwd, comments })
  )
  handle(IPC_CHANNELS.diffReview, async (_e, input: Record<string, unknown>) => {
    const cwd = await validateCwd(input?.['cwd'])
    const reply = await requireSide().ask({ cwd, prompt: REVIEW_PROMPT, model: input?.['model'] })
    const remarks = parseReviewComments(reply)
    if (remarks !== null) {
      await reviewComments.replacePi(cwd, remarks)
    }
    return remarks
  })
  handle(IPC_CHANNELS.reviewCommentsList, async (_e, input: { cwd: unknown }) =>
    reviewComments.list(await validateCwd(input?.cwd))
  )
  handle(IPC_CHANNELS.reviewCommentsAdd, async (_e, input: Record<string, unknown>) =>
    reviewComments.add(await validateCwd(input?.['cwd']), {
      path: input?.['path'],
      line: input?.['line'],
      lineText: input?.['lineText'],
      text: input?.['text']
    })
  )
  handle(IPC_CHANNELS.reviewCommentsRemove, async (_e, input: { cwd: unknown; ids: unknown }) =>
    reviewComments.remove(await validateCwd(input?.cwd), input?.ids)
  )
  handle(IPC_CHANNELS.reviewCommentsClear, async (_e, input: { cwd: unknown; paths?: unknown }) =>
    reviewComments.clear(await validateCwd(input?.cwd), input?.paths)
  )

  // --- Automations ----------------------------------------------------------

  const automationsChanged = () => {
    deps.automations?.refresh()
    broadcastAll(IPC_CHANNELS.automationsChanged, null)
  }
  handle(IPC_CHANNELS.automationsList, () => listAutomations())
  handle(IPC_CHANNELS.automationsSave, async (_e, input: unknown) => {
    const cwd = (input as { cwd?: unknown } | null)?.cwd
    if (typeof cwd === 'string' && cwd !== '') {
      await validateCwd(cwd) // the project folder must exist
    }
    const saved = await saveAutomation(input)
    automationsChanged()
    return saved
  })
  handle(IPC_CHANNELS.automationsDelete, async (_e, input: { id?: unknown }) => {
    await deleteAutomation(input?.id)
    automationsChanged()
  })
  handle(IPC_CHANNELS.automationsRunNow, async (_e, input: { id?: unknown }) => {
    const automation = (await listAutomations()).find((a) => a.id === input?.id)
    if (!automation) {
      throw new Error('Unknown automation')
    }
    // Runs are hosted by a window (the chat starts in its renderer).
    if (!(await deps.automations?.trigger(automation))) {
      throw new Error('Open a Pi Desktop window on the computer to run automations')
    }
    await markAutomationRun(automation.id, Date.now())
    automationsChanged()
  })
  handle(
    IPC_CHANNELS.automationsSetSession,
    async (_e, input: { id?: unknown; sessionPath?: unknown }) => {
      if (typeof input?.id !== 'string') {
        throw new Error('Invalid automation id')
      }
      await setAutomationSession(input.id, validateSessionPath(input.sessionPath))
      broadcastAll(IPC_CHANNELS.automationsChanged, null)
    }
  )

  // --- Pull request status (GitHub CLI) ---------------------------------------

  handle(IPC_CHANNELS.prStatus, async (_e, input: { cwd: string }) =>
    getPrStatus(await validateCwd(input?.cwd))
  )
  handle(
    IPC_CHANNELS.prFailedLog,
    async (_e, input: { cwd: string; runId?: unknown }) =>
      getFailedLog(await validateCwd(input?.cwd), input?.runId)
  )

  handle(IPC_CHANNELS.diffDiscard, async (_e, input: { cwd: string; path: unknown }) => {
    const cwd = await validateCwd(input?.cwd)
    const outcome = await discardFile(cwd, input?.path, (absolute) => shell.trashItem(absolute))
    if (outcome.ok && typeof input?.path === 'string') {
      await reviewComments.clear(cwd, [input.path])
    }
    return outcome
  })
  handle(IPC_CHANNELS.diffCommit, async (_e, input: { cwd: string; message: unknown }) => {
    const cwd = await validateCwd(input?.cwd)
    const outcome = await commitAll(cwd, input?.message)
    if (outcome.ok) {
      await reviewComments.clear(cwd) // the changes they were about are committed
    }
    return outcome
  })
  handle(IPC_CHANNELS.diffPush, async (_e, input: { cwd: string }) => {
    const cwd = await validateCwd(input?.cwd)
    return pushBranch(cwd)
  })

  handle(IPC_CHANNELS.projectsAdd, async (_e, input: { cwd: string }) => {
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

  handle(IPC_CHANNELS.settingsGet, () => readSettings())

  handle(IPC_CHANNELS.appSettingsGet, () => loadAppSettings())

  handle(IPC_CHANNELS.appSettingsUpdate, async (_e, patch: unknown) => {
    const next = await updateAppSettings(patch)
    nativeTheme.themeSource = next.theme
    if (
      patch !== null &&
      typeof patch === 'object' &&
      'piRuntime' in (patch as Record<string, unknown>)
    ) {
      await applyRuntimeSettings(deps.pool)
    }
    // computerUse.enabled is baked into each pi's spawn env, so warm spares
    // kept for adoption must be respawned with the new flag.
    if (
      patch !== null &&
      typeof patch === 'object' &&
      'computerUse' in (patch as Record<string, unknown>)
    ) {
      void deps.chat.resetSpares().catch(() => {})
    }
    if (
      patch !== null &&
      typeof patch === 'object' &&
      'remote' in (patch as Record<string, unknown>)
    ) {
      await deps.remote?.apply(next.remote.enabled).catch(() => {})
    }
    return next
  })

  handle(IPC_CHANNELS.appUserFirstName, () => resolveUserFirstName())

  handle(IPC_CHANNELS.appPickFolder, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0]!, {
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle(
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

  handle(
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

  handle(IPC_CHANNELS.appRevealPath, (_e, path: string) => {
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096) {
      throw new Error('Invalid path')
    }
    shell.showItemInFolder(path)
  })

  handle(
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
      // E2E hook: answer with a fixed button instead of showing the dialog.
      const stub = process.env['PI_DESKTOP_CONFIRM_CHOICE']
      if (process.env['PI_DESKTOP_E2E'] === '1' && stub !== undefined && /^\d$/.test(stub)) {
        return Math.min(Number(stub), input.buttons.length - 1)
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

  handle(IPC_CHANNELS.appInfo, () => {
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
      homeDir: home,
      workspaceDir: workspaceDir()
    }
  })

  handle(IPC_CHANNELS.appOpenAgentDir, () => shell.openPath(getAgentDir()))

  handle(IPC_CHANNELS.appLocalServers, async (): Promise<LocalServer[]> => {
    // The browser-tools bridge listens on loopback — never surface it as a
    // "local server" the user can open.
    const bridgePort = Number(new URL(deps.bridge?.url ?? 'http://x:0').port)
    const exclude = Number.isInteger(bridgePort) && bridgePort > 0 ? [bridgePort] : []
    return listLocalServers(exclude)
  })

  // --- Computer use (native macOS app control) ----------------------------

  const cuaPermissions = async (prompt: boolean) => {
    const cua = deps.cua
    if (!cua?.available()) {
      return { available: false, accessibility: false, screenRecording: false }
    }
    const result = (await cua.call('permissions', { prompt })) as {
      accessibility?: boolean
      screenRecording?: boolean
    }
    const accessibility = result.accessibility === true
    if (!accessibility) {
      // A running helper may hold on to the state it saw at launch.
      cua.recycle()
    }
    return {
      available: true,
      accessibility,
      screenRecording: result.screenRecording === true,
      appAccessibility: systemPreferences.isTrustedAccessibilityClient(false),
      canReset: canResetCuaPermissions()
    }
  }

  handle(IPC_CHANNELS.cuaPermissions, () => cuaPermissions(false))
  handle(IPC_CHANNELS.cuaRequestPermissions, () => {
    // Registers the app in the Accessibility list; the helper inherits the
    // grant as our child (TCC attributes it to the responsible process).
    systemPreferences.isTrustedAccessibilityClient(true)
    return cuaPermissions(true)
  })
  handle(IPC_CHANNELS.cuaResetPermissions, async () => {
    if (!canResetCuaPermissions()) {
      return cuaPermissions(false)
    }
    // A privacy entry stores the code requirement of the build that asked
    // first; after a signing change the switch shows "on" but no longer
    // matches. tccutil drops only Pi Desktop's own entries.
    for (const service of ['Accessibility', 'ScreenCapture']) {
      await new Promise<void>((resolvePromise) => {
        execFile('/usr/bin/tccutil', ['reset', service, APP_BUNDLE_ID], () => resolvePromise())
      })
    }
    deps.cua?.recycle()
    // Re-registers Pi Desktop in both lists: the Accessibility prompt comes
    // from the app itself, the Screen Recording one from the (fresh) helper.
    systemPreferences.isTrustedAccessibilityClient(true)
    return cuaPermissions(true)
  })
  handle(IPC_CHANNELS.cuaOpenSettings, (_e, input: { pane?: unknown }) => {
    const pane = input?.pane
    if (pane !== 'accessibility' && pane !== 'screenRecording') {
      return Promise.resolve()
    }
    const anchor =
      pane === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture'
    return shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${anchor}`
    )
  })
  handle(IPC_CHANNELS.cuaPause, () => deps.cua?.pause())
  handle(IPC_CHANNELS.cuaResume, () => deps.cua?.resume())
  handle(IPC_CHANNELS.cuaStop, () =>
    deps.cua?.abortAll('Computer use stopped by the user')
  )
  // E2E hook: lets tests drive the activity strip without a real helper.
  // Inert unless PI_DESKTOP_E2E=1 was set at launch.
  handle(IPC_CHANNELS.cuaTestActivity, (_e, input: unknown) => {
    if (process.env['PI_DESKTOP_E2E'] !== '1') {
      return
    }
    const payload = input as {
      chatId?: unknown
      phase?: unknown
      cmd?: unknown
      app?: unknown
      summary?: unknown
    } | null
    broadcastAll(IPC_CHANNELS.cuaActivity, {
      chatId: typeof payload?.chatId === 'string' ? payload.chatId : undefined,
      phase:
        payload?.phase === 'start' ||
        payload?.phase === 'end' ||
        payload?.phase === 'paused' ||
        payload?.phase === 'resumed'
          ? payload.phase
          : 'start',
      cmd: typeof payload?.cmd === 'string' ? payload.cmd : 'computer_state',
      app: typeof payload?.app === 'string' ? payload.app : undefined,
      summary: typeof payload?.summary === 'string' ? payload.summary : 'Test activity'
    })
  })

  handle(IPC_CHANNELS.chatOpen, (_e, input: ChatOpenInput) => deps.chat.open(input))
  handle(IPC_CHANNELS.chatSend, (_e, input: ChatSendInput) => deps.chat.send(input))
  handle(IPC_CHANNELS.chatAbort, (_e, input: { chatId: string }) =>
    deps.chat.abort(input)
  )
  handle(IPC_CHANNELS.chatBash, (_e, input: { chatId: string; command: string }) =>
    deps.chat.bash(input)
  )
  handle(IPC_CHANNELS.chatAbortBash, (_e, input: { chatId: string }) =>
    deps.chat.abortBash(input)
  )
  handle(IPC_CHANNELS.chatClearQueue, (_e, input: { chatId: string }) =>
    deps.chat.clearQueue(input)
  )
  handle(
    IPC_CHANNELS.chatSetModel,
    (_e, input: { chatId: string; provider: string; modelId: string }) =>
      deps.chat.setModel(input)
  )
  handle(
    IPC_CHANNELS.chatSetThinkingLevel,
    (_e, input: { chatId: string; level: ThinkingLevel }) => deps.chat.setThinkingLevel(input)
  )
  handle(IPC_CHANNELS.chatGetStats, (_e, input: { chatId: string }) =>
    deps.chat.getStats(input)
  )
  handle(IPC_CHANNELS.chatSetCwd, (_e, input: { chatId: string; cwd: string }) =>
    deps.chat.setCwd(input)
  )
  handle(
    IPC_CHANNELS.chatCompact,
    (_e, input: { chatId: string; customInstructions?: string }) => deps.chat.compact(input)
  )
  handle(
    IPC_CHANNELS.chatSetSessionName,
    (_e, input: { chatId: string; name: string }) => deps.chat.setSessionName(input)
  )
  handle(
    IPC_CHANNELS.chatExportHtml,
    (_e, input: { chatId: string; outputPath: string }) => deps.chat.exportHtml(input)
  )
  handle(
    IPC_CHANNELS.chatRespondUi,
    (_e, input: { chatId: string } & Record<string, unknown>) => deps.chat.respondUi(input)
  )
  handle(
    IPC_CHANNELS.chatRefresh,
    (_e, input: { chatId: string }) => deps.chat.refresh(input)
  )
  handle(IPC_CHANNELS.chatGetForkMessages, (_e, input: { chatId: string }) =>
    deps.chat.getForkMessages(input)
  )
  handle(
    IPC_CHANNELS.chatFork,
    (_e, input: { chatId: string; entryId: string }) => deps.chat.fork(input)
  )
  handle(IPC_CHANNELS.chatClone, (_e, input: { chatId: string }) =>
    deps.chat.clone(input)
  )
  handle(IPC_CHANNELS.chatIdForSession, (_e, input: { sessionPath: string }) =>
    deps.chat.chatIdForSession(validateSessionPath(input.sessionPath))
  )
  handle(IPC_CHANNELS.chatClose, (_e, input: { chatId: string }) => deps.chat.close(input))
  handle(IPC_CHANNELS.chatWarm, (_e, input: { cwd: string }) =>
    deps.chat.warmCwd(input)
  )

  handle(
    IPC_CHANNELS.chatTranscript,
    (_e, input: { sessionPath: string; limit?: number; before?: number }) => {
      const sessionPath = validateSessionPath(input.sessionPath)
      const limit =
        typeof input?.limit === 'number' && Number.isFinite(input.limit)
          ? Math.min(Math.max(Math.floor(input.limit), 1), 20_000)
          : undefined
      const before =
        typeof input?.before === 'number' && Number.isFinite(input.before) && input.before >= 0
          ? Math.floor(input.before)
          : undefined
      return readSessionTranscript(sessionPath, {
        ...(limit ? { limit } : {}),
        ...(before !== undefined ? { before } : {})
      })
    }
  )

  handle(IPC_CHANNELS.chatFocus, (_e, input: { chatId: string }) => {
    deps.chat.markFocused(validateChatId(input.chatId))
  })

  handle(IPC_CHANNELS.catalogGet, async () => {
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

  handle(
    IPC_CHANNELS.sessionsRename,
    (_e, input: { sessionPath: string; name: string }) => deps.chat.renameSession(input)
  )
  handle(
    IPC_CHANNELS.sessionsExportHtml,
    (_e, input: { sessionPath: string; outputPath: string }) =>
      deps.chat.exportSession(input)
  )
  handle(IPC_CHANNELS.sessionsDelete, async (_e, input: { sessionPath: string }) => {
    const sessionPath = validateSessionPath(input.sessionPath)
    await deps.chat.closeChatForSession(sessionPath)
    await shell.trashItem(sessionPath)
    await removeSessionMeta(sessionPath)
    broadcastAll(IPC_CHANNELS.sessionMetaChanged, await getSessionMeta())
  })

  handle(IPC_CHANNELS.sessionMetaGet, () => getSessionMeta())

  handle(
    IPC_CHANNELS.sessionMetaSet,
    async (_e, input: { sessionPath: string; patch: unknown }) => {
      const sessionPath = validateSessionPath(input.sessionPath)
      const patch = input?.patch as { pinned?: unknown; archived?: unknown } | null
      const next: { pinned?: boolean; archived?: boolean } = {}
      if (patch?.pinned !== undefined) {
        if (typeof patch.pinned !== 'boolean') {
          throw new Error('Invalid patch')
        }
        next.pinned = patch.pinned
      }
      if (patch?.archived !== undefined) {
        if (typeof patch.archived !== 'boolean') {
          throw new Error('Invalid patch')
        }
        next.archived = patch.archived
      }
      const map = await setSessionMeta(sessionPath, next)
      broadcastAll(IPC_CHANNELS.sessionMetaChanged, map)
      return map
    }
  )

  handle(IPC_CHANNELS.filesList, async (_e, input: { cwd: string }) => {
    const cwd = await validateCwd(input?.cwd)
    return { files: await listProjectFiles(cwd) }
  })

  handle(IPC_CHANNELS.filesReadAttachments, (_e, input: { paths: unknown }) => {
    const paths = Array.isArray(input?.paths)
      ? input.paths.filter(
          (p): p is string => typeof p === 'string' && isAbsolute(p) && p.length < 4096
        )
      : []
    return readAttachments(paths.slice(0, 16))
  })

  handle(IPC_CHANNELS.dialogPickFiles, async (event) => {
    // E2E hook: deterministic paths instead of the native dialog.
    const stub = process.env['PI_DESKTOP_PICK_FILES']
    if (process.env['PI_DESKTOP_E2E'] === '1' && stub) {
      return { paths: stub.split(delimiter).filter(Boolean) }
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0]!, {
      properties: ['openFile', 'multiSelections']
    })
    return { paths: result.canceled ? [] : result.filePaths }
  })

  handle(
    IPC_CHANNELS.sessionsMenu,
    (
      event,
      input: { sessionPath: string; pinned?: boolean; archived?: boolean }
    ): Promise<SessionMenuAction | null> => {
      validateSessionPath(input.sessionPath)
      return popupMenu<SessionMenuAction>(event, [
        input.pinned === true
          ? { id: 'unpin', label: 'Unpin' }
          : { id: 'pin', label: 'Pin' },
        input.archived === true
          ? { id: 'unarchive', label: 'Unarchive' }
          : { id: 'archive', label: 'Archive' },
        { type: 'separator' },
        { id: 'rename', label: 'Rename…' },
        { id: 'export', label: 'Export as HTML…' },
        { id: 'reveal', label: 'Reveal in Finder' },
        { id: 'copy-path', label: 'Copy Session Path' },
        { type: 'separator' },
        { id: 'delete', label: 'Move to Trash…' }
      ])
    }
  )

  handle(
    IPC_CHANNELS.projectsMenu,
    (event, input: { cwd: string }): Promise<ProjectMenuAction | null> => {
      if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) {
        throw new Error('Invalid cwd')
      }
      const worktree = isAppWorktree(resolve(input.cwd), worktreesDir())
      return popupMenu<ProjectMenuAction>(event, [
        { id: 'new-chat', label: 'New Chat in This Project' },
        ...(worktree ? [] : [{ id: 'new-worktree', label: 'New Chat in a Worktree' }]),
        { type: 'separator' },
        { id: 'reveal', label: 'Reveal in Finder' },
        { id: 'open-in', label: 'Open in…' },
        { type: 'separator' },
        ...(worktree ? [{ id: 'remove-worktree', label: 'Remove Worktree…' }] : []),
        { id: 'hide', label: 'Hide from List' }
      ])
    }
  )

  handle(
    IPC_CHANNELS.chatMenu,
    (
      event,
      input: { chatId: string; pinned?: boolean; archived?: boolean }
    ): Promise<ChatMenuAction | null> => {
      validateChatId(input.chatId)
      return popupMenu<ChatMenuAction>(event, [
        input.pinned === true
          ? { id: 'unpin', label: 'Unpin' }
          : { id: 'pin', label: 'Pin' },
        input.archived === true
          ? { id: 'unarchive', label: 'Unarchive' }
          : { id: 'archive', label: 'Archive' },
        { type: 'separator' },
        { id: 'rename', label: 'Rename…' },
        { id: 'export', label: 'Export as HTML…' },
        { id: 'clone', label: 'Fork Chat' },
        { id: 'reveal', label: 'Reveal in Finder' },
        { type: 'separator' },
        { id: 'delete', label: 'Move to Trash…' }
      ])
    }
  )

  handle(IPC_CHANNELS.chatReload, (_e, input: { chatId: string }) =>
    deps.chat.reload(input)
  )
  handle(IPC_CHANNELS.chatGetTree, (_e, input: { chatId: string }) =>
    deps.chat.getTree(input)
  )
  handle(IPC_CHANNELS.chatLastAssistantText, (_e, input: { chatId: string }) =>
    deps.chat.getLastAssistantText(input)
  )

  handle(IPC_CHANNELS.sessionsImport, async (_e, input: { path: string }) => {
    if (typeof input?.path !== 'string' || !isAbsolute(input.path)) {
      throw new Error('Invalid import path')
    }
    return importSessionFile(input.path)
  })

  handle(
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

  handle(IPC_CHANNELS.runtimeCommand, async () => {
    const runtime = await deps.pool.getRuntime()
    return { command: runtime.command, args: runtime.args }
  })

  handle(IPC_CHANNELS.terminalSpawn, async (_e, input: TerminalSpawnInput) => {
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
  handle(IPC_CHANNELS.terminalWrite, (_e, input: { id: string; data: string }) => {
    if (typeof input?.id !== 'string' || typeof input.data !== 'string') {
      throw new Error('Invalid terminal write')
    }
    deps.pty.write(input.id, input.data)
  })
  handle(
    IPC_CHANNELS.terminalResize,
    (_e, input: { id: string; cols: number; rows: number }) => {
      if (typeof input?.id !== 'string') {
        throw new Error('Invalid terminal resize')
      }
      deps.pty.resize(input.id, input.cols, input.rows)
    }
  )
  handle(IPC_CHANNELS.terminalKill, (_e, input: { id: string }) => {
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

  handle(IPC_CHANNELS.browserCreate, (_e, input: { id: string; url?: string }) =>
    deps.browser.create(browserId(input?.id), typeof input?.url === 'string' ? input.url : undefined)
  )
  handle(IPC_CHANNELS.browserNavigate, (_e, input: { id: string; url: string }) => {
    if (typeof input?.url !== 'string' || input.url.length > 4096) {
      throw new Error('Invalid URL')
    }
    deps.browser.navigate(browserId(input.id), input.url)
  })
  handle(IPC_CHANNELS.browserBack, (_e, input: { id: string }) =>
    deps.browser.goBack(browserId(input?.id))
  )
  handle(IPC_CHANNELS.browserForward, (_e, input: { id: string }) =>
    deps.browser.goForward(browserId(input?.id))
  )
  handle(IPC_CHANNELS.browserReloadOrStop, (_e, input: { id: string }) =>
    deps.browser.reloadOrStop(browserId(input?.id))
  )
  handle(IPC_CHANNELS.browserClose, (_e, input: { id: string }) =>
    deps.browser.close(browserId(input?.id))
  )
  handle(
    IPC_CHANNELS.browserSetVisible,
    (_e, input: { id: string | null; rect?: BrowserRect }) => {
      deps.browser.setVisible(
        input?.id === null ? null : browserId(input?.id),
        input?.rect && typeof input.rect === 'object' ? input.rect : undefined
      )
    }
  )
  handle(IPC_CHANNELS.browserSetOverlay, (_e, input: { open: boolean }) =>
    deps.browser.setOverlayOpen(input?.open === true)
  )

  handle(IPC_CHANNELS.diffStatus, (_e, input: { cwd: string }) =>
    validateCwd(input?.cwd).then((cwd) => getRepoDiff(cwd))
  )

  handle(IPC_CHANNELS.diffSummary, (_e, input: { cwd: string }) =>
    validateCwd(input?.cwd).then((cwd) => getRepoSummary(cwd))
  )

  // "Open in": the menu is built and acted on here, so the renderer never
  // names an application to launch.
  handle(IPC_CHANNELS.appOpenInMenu, async (event, input: { cwd: string }) => {
    const cwd = await validateCwd(input?.cwd)
    const targets = await listOpenTargets()
    const fileManager = process.platform === 'darwin' ? 'Finder' : 'File Manager'
    const choice = await popupMenu<string>(event, [
      { id: 'finder', label: fileManager },
      ...(targets.length > 0 ? [{ type: 'separator' as const }] : []),
      ...targets.map((t) => ({ id: t.id, label: t.label })),
      { type: 'separator' as const },
      { id: 'copy', label: 'Copy Path' }
    ])
    if (choice === 'finder') {
      await shell.openPath(cwd)
    } else if (choice === 'copy') {
      clipboard.writeText(cwd)
    } else if (choice) {
      const target = targets.find((t) => t.id === choice)
      if (target) {
        await openInTarget(target, cwd)
      }
    }
  })

  // --- Release updates ------------------------------------------------------

  handle(IPC_CHANNELS.updatesGet, () => deps.updates?.current ?? null)
  handle(IPC_CHANNELS.updatesCheckNow, async () => {
    if (!deps.updates) {
      return { status: 'unavailable' }
    }
    return deps.updates.checkNow()
  })
  handle(IPC_CHANNELS.updatesOpen, () => {
    const url = deps.updates?.current?.url
    // The URL came from the GitHub API and was prefix-validated on fetch;
    // re-check before opening in case the cached value was tampered with.
    if (
      typeof url === 'string' &&
      url.startsWith('https://github.com/azygoss/pi-desktop/') &&
      url.length < 2048
    ) {
      return shell.openExternal(url)
    }
  })

  // --- Dictation ------------------------------------------------------------

  handle(IPC_CHANNELS.dictationPermissions, async () => {
    if (!deps.dictation?.available()) {
      return {
        available: false,
        microphone: 'unknown',
        speech: 'unknown'
      }
    }
    const result = (await deps.dictation.call('permissions')) as {
      microphone?: unknown
      speech?: unknown
    }
    const stat = (v: unknown) =>
      v === 'authorized' || v === 'denied' || v === 'restricted' || v === 'notDetermined'
        ? v
        : 'unknown'
    return {
      available: true,
      microphone: stat(result.microphone),
      speech: stat(result.speech)
    }
  })
  handle(IPC_CHANNELS.dictationLocales, async () => {
    if (!deps.dictation?.available()) {
      return { locales: [] as string[] }
    }
    const result = (await deps.dictation.call('locales')) as { locales?: unknown }
    return {
      locales: Array.isArray(result.locales)
        ? result.locales.filter((l): l is string => typeof l === 'string').slice(0, 200)
        : []
    }
  })
  handle(IPC_CHANNELS.dictationStart, async (_e, input: unknown) => {
    if (!deps.dictation?.available()) {
      throw new Error('dictation is not available')
    }
    const i = input as { locale?: unknown; autoStop?: unknown } | null
    const locale = typeof i?.locale === 'string' && i.locale.length <= 64 ? i.locale : undefined
    const autoStop = i?.autoStop === true
    await deps.dictation.start({ ...(locale ? { locale } : {}), autoStop })
  })
  handle(IPC_CHANNELS.dictationStop, () => deps.dictation?.stop())
  handle(IPC_CHANNELS.dictationCancel, () => deps.dictation?.cancel())
  handle(IPC_CHANNELS.dictationOpenSettings, (_e, input: { pane?: unknown }) => {
    const anchor =
      input?.pane === 'microphone'
        ? 'Privacy_Microphone'
        : input?.pane === 'speech'
          ? 'Privacy_SpeechRecognition'
          : undefined
    if (!anchor) {
      return Promise.resolve()
    }
    return shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${anchor}`
    )
  })
  // E2E hook: inject a synthetic dictation event (inert unless PI_DESKTOP_E2E=1).
  handle(IPC_CHANNELS.dictationTestEvent, (_e, input: unknown) => {
    if (process.env['PI_DESKTOP_E2E'] !== '1') {
      return
    }
    const e = input as { event?: unknown; text?: unknown; rms?: unknown; message?: unknown }
    if (typeof e?.event !== 'string' || e.event.length > 32) {
      return
    }
    broadcastAll(IPC_CHANNELS.dictationEvent, {
      event: e.event,
      ...(typeof e.text === 'string' ? { text: e.text.slice(0, 4096) } : {}),
      ...(typeof e.rms === 'number' ? { rms: Math.max(0, Math.min(1, e.rms)) } : {}),
      ...(typeof e.message === 'string' ? { message: e.message.slice(0, 500) } : {})
    })
  })

  handle(IPC_CHANNELS.appQuit, () => {
    app.quit()
  })

  // Shown notifications are kept referenced so the click handler isn't
  // garbage-collected before macOS delivers it.
  const shownNotifications = new Set<Notification>()
  handle(IPC_CHANNELS.appNotify, (_e, input: unknown) => {
    if (!Notification.isSupported()) {
      return
    }
    const n = input as { chatId?: unknown; title?: unknown; body?: unknown } | null
    const chatId =
      typeof n?.chatId === 'string' && n.chatId.length > 0 && n.chatId.length <= 128
        ? n.chatId
        : undefined
    if (!chatId) {
      return
    }
    const title = typeof n?.title === 'string' ? n.title.slice(0, 200) : 'Pi'
    const body = typeof n?.body === 'string' ? n.body.slice(0, 500) : ''
    const notification = new Notification({ title, body })
    shownNotifications.add(notification)
    notification.once('close', () => shownNotifications.delete(notification))
    notification.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) {
        return
      }
      if (win.isMinimized()) {
        win.restore()
      }
      win.show()
      win.focus()
      win.webContents.send(IPC_CHANNELS.appOpenChat, { chatId })
    })
    notification.show()
  })

  handle(IPC_CHANNELS.appSetBadge, (_e, input: unknown) => {
    const count = Math.floor(Number((input as { count?: unknown } | null)?.count))
    if (!Number.isInteger(count) || count < 0 || count > 999) {
      return
    }
    app.setBadgeCount(count)
  })

  handle(IPC_CHANNELS.appOpenExternal, (_e, url: string) => {
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
  return watchSessions(() => broadcastAll(IPC_CHANNELS.sessionsChanged, undefined))
}

export function wireAppLifecycle(deps: IpcDeps): void {
  app.on('before-quit', () => {
    void deps.side?.closeAll()
    void deps.chat.closeAll()
    void deps.pty.killAll()
    deps.browser.closeAll()
    void deps.bridge?.stop()
    deps.cua?.dispose()
    deps.dictation?.dispose()
  })
}

/** Send a channel message to all open windows. */
export function broadcastAll(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
  remoteSink?.(channel, payload)
}

export { CHAT_CHANNELS }

/** Resetting privacy entries only makes sense for the signed app bundle. */
function canResetCuaPermissions(): boolean {
  return process.platform === 'darwin' && app.isPackaged
}
