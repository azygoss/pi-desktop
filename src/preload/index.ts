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
    info: () => ipcRenderer.invoke('pi-desktop:runtime:info'),
    refresh: () => ipcRenderer.invoke('pi-desktop:runtime:refresh'),
    command: () => ipcRenderer.invoke('pi-desktop:runtime:command')
  },
  sessions: {
    list: () => ipcRenderer.invoke('pi-desktop:sessions:list'),
    onChanged: subscribe('pi-desktop:sessions:changed'),
    rename: (input) => ipcRenderer.invoke('pi-desktop:sessions:rename', input),
    exportHtml: (input) => ipcRenderer.invoke('pi-desktop:sessions:export-html', input),
    exportFile: (input) => ipcRenderer.invoke('pi-desktop:sessions:export-file', input),
    import: (input) => ipcRenderer.invoke('pi-desktop:sessions:import', input),
    delete: (input) => ipcRenderer.invoke('pi-desktop:sessions:delete', input),
    showMenu: (input) => ipcRenderer.invoke('pi-desktop:sessions:menu', input)
  },
  projects: {
    list: () => ipcRenderer.invoke('pi-desktop:projects:list'),
    add: (input) => ipcRenderer.invoke('pi-desktop:projects:add', input),
    showMenu: (input) => ipcRenderer.invoke('pi-desktop:projects:menu', input)
  },
  settings: {
    get: () => ipcRenderer.invoke('pi-desktop:settings:get')
  },
  appSettings: {
    get: () => ipcRenderer.invoke('pi-desktop:app-settings:get'),
    update: (patch) => ipcRenderer.invoke('pi-desktop:app-settings:update', patch)
  },
  terminal: {
    spawn: (input) => ipcRenderer.invoke('pi-desktop:terminal:spawn', input),
    write: (input) => ipcRenderer.invoke('pi-desktop:terminal:write', input),
    resize: (input) => ipcRenderer.invoke('pi-desktop:terminal:resize', input),
    kill: (input) => ipcRenderer.invoke('pi-desktop:terminal:kill', input),
    onData: subscribe('pi-desktop:terminal:data'),
    onExit: subscribe('pi-desktop:terminal:exit')
  },
  browser: {
    create: (input) => ipcRenderer.invoke('pi-desktop:browser:create', input),
    navigate: (input) => ipcRenderer.invoke('pi-desktop:browser:navigate', input),
    goBack: (input) => ipcRenderer.invoke('pi-desktop:browser:back', input),
    goForward: (input) => ipcRenderer.invoke('pi-desktop:browser:forward', input),
    reloadOrStop: (input) => ipcRenderer.invoke('pi-desktop:browser:reload-or-stop', input),
    close: (input) => ipcRenderer.invoke('pi-desktop:browser:close', input),
    setVisible: (input) => ipcRenderer.invoke('pi-desktop:browser:set-visible', input),
    setOverlayOpen: (input) => ipcRenderer.invoke('pi-desktop:browser:set-overlay', input),
    onState: subscribe('pi-desktop:browser:state'),
    onOpenUrl: subscribe('pi-desktop:browser:open-url'),
    onDownload: subscribe('pi-desktop:browser:downloaded'),
    onAgentTab: subscribe('pi-desktop:browser:agent-tab')
  },
  diff: {
    status: (input) => ipcRenderer.invoke('pi-desktop:diff:status', input)
  },
  app: {
    getUserFirstName: () => ipcRenderer.invoke('pi-desktop:app:user-first-name'),
    pickFolder: () => ipcRenderer.invoke('pi-desktop:app:pick-folder'),
    pickFile: (filters) => ipcRenderer.invoke('pi-desktop:app:pick-file', { filters }),
    saveFile: (input) => ipcRenderer.invoke('pi-desktop:app:save-file', input),
    revealPath: (path) => ipcRenderer.invoke('pi-desktop:app:reveal-path', path),
    confirmDialog: (input) => ipcRenderer.invoke('pi-desktop:app:confirm-dialog', input),
    getAppInfo: () => ipcRenderer.invoke('pi-desktop:app:info'),
    openAgentDir: () => ipcRenderer.invoke('pi-desktop:app:open-agent-dir'),
    openExternal: (url) => ipcRenderer.invoke('pi-desktop:app:open-external', url),
    quit: () => ipcRenderer.invoke('pi-desktop:app:quit'),
    onMenuAction: subscribe('pi-desktop:menu:action')
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
    reload: (input) => ipcRenderer.invoke('pi-desktop:chat:reload', input),
    getTree: (input) => ipcRenderer.invoke('pi-desktop:chat:get-tree', input),
    getLastAssistantText: (input) =>
      ipcRenderer.invoke('pi-desktop:chat:last-assistant-text', input),
    getForkMessages: (input) => ipcRenderer.invoke('pi-desktop:chat:get-fork-messages', input),
    fork: (input) => ipcRenderer.invoke('pi-desktop:chat:fork', input),
    clone: (input) => ipcRenderer.invoke('pi-desktop:chat:clone', input),
    chatIdForSession: (input) => ipcRenderer.invoke('pi-desktop:chat:id-for-session', input),
    showMenu: (input) => ipcRenderer.invoke('pi-desktop:chat:menu', input),
    respondUi: (input) => ipcRenderer.invoke('pi-desktop:chat:respond-ui', input),
    close: (input) => ipcRenderer.invoke('pi-desktop:chat:close', input),
    focus: (input) => ipcRenderer.invoke('pi-desktop:chat:focus', input),
    readTranscript: (input) => ipcRenderer.invoke('pi-desktop:chat:transcript', input),
    onEvent: subscribe('pi-desktop:chat:event'),
    onReady: subscribe('pi-desktop:chat:ready'),
    onUiRequest: subscribe('pi-desktop:chat:ui-request'),
    onExit: subscribe('pi-desktop:chat:exit')
  },
  catalog: {
    get: () => ipcRenderer.invoke('pi-desktop:catalog:get')
  }
}

contextBridge.exposeInMainWorld('piDesktop', api)
