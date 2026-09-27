import { contextBridge, ipcRenderer } from 'electron'
import type { PiDesktopApi } from '../shared/api'

function subscribe(channel: string) {
  return <P>(callback: (payload: P) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload as P)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.off(channel, listener)
  }
}

const api: PiDesktopApi = {
  runtime: {
    info: () => ipcRenderer.invoke('pi-desktop:runtime:info')
  },
  sessions: {
    list: () => ipcRenderer.invoke('pi-desktop:sessions:list'),
    onChanged: subscribe('pi-desktop:sessions:changed'),
    rename: (input) => ipcRenderer.invoke('pi-desktop:sessions:rename', input),
    exportHtml: (input) => ipcRenderer.invoke('pi-desktop:sessions:export-html', input),
    delete: (input) => ipcRenderer.invoke('pi-desktop:sessions:delete', input),
    showMenu: (input) => ipcRenderer.invoke('pi-desktop:sessions:menu', input)
  },
  projects: {
    list: () => ipcRenderer.invoke('pi-desktop:projects:list'),
    showMenu: (input) => ipcRenderer.invoke('pi-desktop:projects:menu', input)
  },
  settings: {
    get: () => ipcRenderer.invoke('pi-desktop:settings:get')
  },
  appSettings: {
    get: () => ipcRenderer.invoke('pi-desktop:app-settings:get'),
    update: (patch) => ipcRenderer.invoke('pi-desktop:app-settings:update', patch)
  },
  app: {
    getUserFirstName: () => ipcRenderer.invoke('pi-desktop:app:user-first-name'),
    pickFolder: () => ipcRenderer.invoke('pi-desktop:app:pick-folder'),
    pickFile: (filters) => ipcRenderer.invoke('pi-desktop:app:pick-file', { filters }),
    saveFile: (input) => ipcRenderer.invoke('pi-desktop:app:save-file', input),
    revealPath: (path) => ipcRenderer.invoke('pi-desktop:app:reveal-path', path),
    confirmDialog: (input) => ipcRenderer.invoke('pi-desktop:app:confirm-dialog', input)
  },
  chat: {
    open: (input) => ipcRenderer.invoke('pi-desktop:chat:open', input),
    send: (input) => ipcRenderer.invoke('pi-desktop:chat:send', input),
    abort: (input) => ipcRenderer.invoke('pi-desktop:chat:abort', input),
    setModel: (input) => ipcRenderer.invoke('pi-desktop:chat:set-model', input),
    setThinkingLevel: (input) => ipcRenderer.invoke('pi-desktop:chat:set-thinking-level', input),
    getStats: (input) => ipcRenderer.invoke('pi-desktop:chat:get-stats', input),
    setCwd: (input) => ipcRenderer.invoke('pi-desktop:chat:set-cwd', input),
    compact: (input) => ipcRenderer.invoke('pi-desktop:chat:compact', input),
    setSessionName: (input) => ipcRenderer.invoke('pi-desktop:chat:set-session-name', input),
    exportHtml: (input) => ipcRenderer.invoke('pi-desktop:chat:export-html', input),
    refresh: (input) => ipcRenderer.invoke('pi-desktop:chat:refresh', input),
    getForkMessages: (input) => ipcRenderer.invoke('pi-desktop:chat:get-fork-messages', input),
    fork: (input) => ipcRenderer.invoke('pi-desktop:chat:fork', input),
    clone: (input) => ipcRenderer.invoke('pi-desktop:chat:clone', input),
    chatIdForSession: (input) => ipcRenderer.invoke('pi-desktop:chat:id-for-session', input),
    showMenu: (input) => ipcRenderer.invoke('pi-desktop:chat:menu', input),
    respondUi: (input) => ipcRenderer.invoke('pi-desktop:chat:respond-ui', input),
    close: (input) => ipcRenderer.invoke('pi-desktop:chat:close', input),
    onEvent: subscribe('pi-desktop:chat:event'),
    onUiRequest: subscribe('pi-desktop:chat:ui-request'),
    onExit: subscribe('pi-desktop:chat:exit')
  }
}

contextBridge.exposeInMainWorld('piDesktop', api)
