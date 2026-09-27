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
    onChanged: subscribe('pi-desktop:sessions:changed')
  },
  projects: {
    list: () => ipcRenderer.invoke('pi-desktop:projects:list')
  },
  settings: {
    get: () => ipcRenderer.invoke('pi-desktop:settings:get')
  },
  app: {
    getUserFirstName: () => ipcRenderer.invoke('pi-desktop:app:user-first-name'),
    pickFolder: () => ipcRenderer.invoke('pi-desktop:app:pick-folder')
  },
  chat: {
    open: (input) => ipcRenderer.invoke('pi-desktop:chat:open', input),
    send: (input) => ipcRenderer.invoke('pi-desktop:chat:send', input),
    abort: (input) => ipcRenderer.invoke('pi-desktop:chat:abort', input),
    setModel: (input) => ipcRenderer.invoke('pi-desktop:chat:set-model', input),
    setThinkingLevel: (input) => ipcRenderer.invoke('pi-desktop:chat:set-thinking-level', input),
    getStats: (input) => ipcRenderer.invoke('pi-desktop:chat:get-stats', input),
    setCwd: (input) => ipcRenderer.invoke('pi-desktop:chat:set-cwd', input),
    respondUi: (input) => ipcRenderer.invoke('pi-desktop:chat:respond-ui', input),
    close: (input) => ipcRenderer.invoke('pi-desktop:chat:close', input),
    onEvent: subscribe('pi-desktop:chat:event'),
    onUiRequest: subscribe('pi-desktop:chat:ui-request'),
    onExit: subscribe('pi-desktop:chat:exit')
  }
}

contextBridge.exposeInMainWorld('piDesktop', api)
