import { contextBridge } from 'electron'

// The typed API surface is added in src/preload alongside the IPC handlers in
// src/main/ipc.ts. Until then, expose a minimal marker so the renderer can
// detect that it runs inside Pi Desktop.
const api = {
  platform: process.platform
}

contextBridge.exposeInMainWorld('piDesktop', api)
