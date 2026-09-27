import { contextBridge, ipcRenderer } from 'electron'
import type { PiDesktopApi } from '../shared/api'

const api: PiDesktopApi = {
  runtime: {
    info: () => ipcRenderer.invoke('pi-desktop:runtime:info')
  },
  sessions: {
    list: () => ipcRenderer.invoke('pi-desktop:sessions:list'),
    onChanged: (callback) => {
      const listener = () => callback()
      ipcRenderer.on('pi-desktop:sessions:changed', listener)
      return () => ipcRenderer.off('pi-desktop:sessions:changed', listener)
    }
  },
  projects: {
    list: () => ipcRenderer.invoke('pi-desktop:projects:list')
  },
  settings: {
    get: () => ipcRenderer.invoke('pi-desktop:settings:get')
  },
  app: {
    getUserFirstName: () => ipcRenderer.invoke('pi-desktop:app:user-first-name')
  }
}

contextBridge.exposeInMainWorld('piDesktop', api)
