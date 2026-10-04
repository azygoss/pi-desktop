import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveToTrash } from './trash'

/**
 * The slice of Electron that the main-process modules touch, for the
 * headless host (`pi-remote`). The host bundle aliases `electron` to this
 * file, so the IPC handlers a paired phone runs are the very same code the
 * desktop app runs. Nothing here has a window: anything that would open
 * native UI fails loudly, and those channels are off the remote allowlist
 * anyway.
 */

function hostDataDir(): string {
  return process.env['PI_DESKTOP_USER_DATA_DIR'] || join(homedir(), '.config', 'pi-remote')
}

function noWindow(): never {
  throw new Error('Not available without a desktop window')
}

const listeners = new Map<string, Set<(...args: unknown[]) => void>>()

export const app = {
  name: 'Pi Remote',
  isPackaged: false,
  getVersion: (): string => process.env['PI_REMOTE_HOST_VERSION'] ?? '0.0.0',
  getName: (): string => 'Pi Remote',
  getAppPath: (): string => process.env['PI_REMOTE_HOST_ROOT'] ?? process.cwd(),
  getPath: (name: string): string => {
    switch (name) {
      case 'userData':
        return hostDataDir()
      case 'home':
        return homedir()
      case 'temp':
        return tmpdir()
      case 'downloads':
        return join(homedir(), 'Downloads')
      default:
        return hostDataDir()
    }
  },
  on: (event: string, listener: (...args: unknown[]) => void): void => {
    const set = listeners.get(event) ?? new Set()
    set.add(listener)
    listeners.set(event, set)
  },
  emit: (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) {
      listener(...args)
    }
  },
  quit: (): void => {
    process.kill(process.pid, 'SIGTERM')
  },
  setBadgeCount: (): boolean => false
}

export const ipcMain = {
  handle: (): void => {},
  removeHandler: (): void => {}
}

export const BrowserWindow = {
  getAllWindows: (): never[] => [],
  getFocusedWindow: (): null => null,
  fromWebContents: (): null => null
}

export class WebContentsView {
  constructor() {
    noWindow()
  }
}

export const session = {
  fromPartition: (): never => noWindow()
}

export const Menu = {
  buildFromTemplate: (): { popup(): void } => ({ popup: () => {} }),
  setApplicationMenu: (): void => {}
}

export class Notification {
  static isSupported(): boolean {
    return false
  }
}

export const nativeTheme = { themeSource: 'system' }

export const systemPreferences = {
  isTrustedAccessibilityClient: (): boolean => false
}

export const clipboard = {
  writeText: (): void => {}
}

export const dialog = {
  showOpenDialog: async (): Promise<never> => noWindow(),
  showSaveDialog: async (): Promise<never> => noWindow(),
  showMessageBox: async (): Promise<never> => noWindow()
}

export const shell = {
  trashItem: (path: string): Promise<void> => moveToTrash(path),
  openExternal: async (): Promise<void> => {},
  openPath: async (): Promise<string> => 'Not available without a desktop window',
  showItemInFolder: (): void => {}
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (): never => noWindow(),
  decryptString: (): never => noWindow()
}

export const globalShortcut = {
  register: (): boolean => false,
  unregister: (): void => {}
}

export default {
  app,
  ipcMain,
  BrowserWindow,
  WebContentsView,
  session,
  Menu,
  Notification,
  nativeTheme,
  systemPreferences,
  clipboard,
  dialog,
  shell,
  safeStorage,
  globalShortcut
}
