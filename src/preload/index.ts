import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PiDesktopApi } from '../shared/api'

function subscribe(channel: string) {
  return <P>(callback: (payload: P) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload as P)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.off(channel, listener)
  }
}

const api: PiDesktopApi = {
  perfEnabled: process.env['PI_DESKTOP_PERF'] === '1',
  runtime: {
    info: () => ipcRenderer.invoke('pi-desktop:runtime:info'),
    refresh: () => ipcRenderer.invoke('pi-desktop:runtime:refresh'),
    command: () => ipcRenderer.invoke('pi-desktop:runtime:command')
  },
  sessions: {
    list: () => ipcRenderer.invoke('pi-desktop:sessions:list'),
    search: (input) => ipcRenderer.invoke('pi-desktop:sessions:search', input),
    usage: () => ipcRenderer.invoke('pi-desktop:sessions:usage'),
    onChanged: subscribe('pi-desktop:sessions:changed'),
    rename: (input) => ipcRenderer.invoke('pi-desktop:sessions:rename', input),
    exportHtml: (input) => ipcRenderer.invoke('pi-desktop:sessions:export-html', input),
    exportFile: (input) => ipcRenderer.invoke('pi-desktop:sessions:export-file', input),
    import: (input) => ipcRenderer.invoke('pi-desktop:sessions:import', input),
    delete: (input) => ipcRenderer.invoke('pi-desktop:sessions:delete', input),
    showMenu: (input) => ipcRenderer.invoke('pi-desktop:sessions:menu', input)
  },
  sessionMeta: {
    get: () => ipcRenderer.invoke('pi-desktop:session-meta:get'),
    set: (input) => ipcRenderer.invoke('pi-desktop:session-meta:set', input),
    onChanged: subscribe('pi-desktop:session-meta:changed')
  },
  files: {
    list: (input) => ipcRenderer.invoke('pi-desktop:files:list', input),
    read: (input) => ipcRenderer.invoke('pi-desktop:files:read', input),
    readAttachments: (input) =>
      ipcRenderer.invoke('pi-desktop:files:read-attachments', input)
  },
  projects: {
    list: () => ipcRenderer.invoke('pi-desktop:projects:list'),
    add: (input) => ipcRenderer.invoke('pi-desktop:projects:add', input),
    showMenu: (input) => ipcRenderer.invoke('pi-desktop:projects:menu', input),
    createWorktree: (input) => ipcRenderer.invoke('pi-desktop:projects:create-worktree', input),
    removeWorktree: (input) => ipcRenderer.invoke('pi-desktop:projects:remove-worktree', input)
  },
  settings: {
    get: () => ipcRenderer.invoke('pi-desktop:settings:get')
  },
  appSettings: {
    get: () => ipcRenderer.invoke('pi-desktop:app-settings:get'),
    update: (patch) => ipcRenderer.invoke('pi-desktop:app-settings:update', patch),
    onChanged: subscribe('pi-desktop:app-settings:changed')
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
    status: (input) => ipcRenderer.invoke('pi-desktop:diff:status', input),
    summary: (input) => ipcRenderer.invoke('pi-desktop:diff:summary', input),
    discard: (input) => ipcRenderer.invoke('pi-desktop:diff:discard', input),
    commit: (input) => ipcRenderer.invoke('pi-desktop:diff:commit', input),
    push: (input) => ipcRenderer.invoke('pi-desktop:diff:push', input),
    review: (input) => ipcRenderer.invoke('pi-desktop:diff:review', input),
    postComments: (input) => ipcRenderer.invoke('pi-desktop:diff:post-comments', input)
  },
  git: {
    branches: (input) => ipcRenderer.invoke('pi-desktop:git:branches', input),
    switchBranch: (input) => ipcRenderer.invoke('pi-desktop:git:switch', input),
    createBranch: (input) => ipcRenderer.invoke('pi-desktop:git:create-branch', input),
    onChanged: subscribe('pi-desktop:git:changed')
  },
  reviewComments: {
    list: (input) => ipcRenderer.invoke('pi-desktop:review-comments:list', input),
    add: (input) => ipcRenderer.invoke('pi-desktop:review-comments:add', input),
    remove: (input) => ipcRenderer.invoke('pi-desktop:review-comments:remove', input),
    clear: (input) => ipcRenderer.invoke('pi-desktop:review-comments:clear', input),
    onChanged: subscribe('pi-desktop:review-comments:changed')
  },
  app: {
    getUserFirstName: () => ipcRenderer.invoke('pi-desktop:app:user-first-name'),
    pickFolder: () => ipcRenderer.invoke('pi-desktop:app:pick-folder'),
    pickFile: (filters) => ipcRenderer.invoke('pi-desktop:app:pick-file', { filters }),
    pickFiles: () =>
      ipcRenderer
        .invoke('pi-desktop:dialog:pick-files')
        .then((r: { paths: string[] }) => r.paths),
    pathForFile: (file) => webUtils.getPathForFile(file),
    saveFile: (input) => ipcRenderer.invoke('pi-desktop:app:save-file', input),
    openInMenu: (input) => ipcRenderer.invoke('pi-desktop:app:open-in-menu', input),
    revealPath: (path) => ipcRenderer.invoke('pi-desktop:app:reveal-path', path),
    confirmDialog: (input) => ipcRenderer.invoke('pi-desktop:app:confirm-dialog', input),
    getAppInfo: () => ipcRenderer.invoke('pi-desktop:app:info'),
    openAgentDir: () => ipcRenderer.invoke('pi-desktop:app:open-agent-dir'),
    openExternal: (url) => ipcRenderer.invoke('pi-desktop:app:open-external', url),
    localServers: () => ipcRenderer.invoke('pi-desktop:app:local-servers'),
    quit: () => ipcRenderer.invoke('pi-desktop:app:quit'),
    notify: (input) => ipcRenderer.invoke('pi-desktop:app:notify', input),
    setBadge: (count) => ipcRenderer.invoke('pi-desktop:app:set-badge', { count }),
    onMenuAction: subscribe('pi-desktop:menu:action'),
    onOpenChat: subscribe('pi-desktop:app:open-chat')
  },
  chat: {
    open: (input) => ipcRenderer.invoke('pi-desktop:chat:open', input),
    send: (input) => ipcRenderer.invoke('pi-desktop:chat:send', input),
    abort: (input) => ipcRenderer.invoke('pi-desktop:chat:abort', input),
    bash: (input) => ipcRenderer.invoke('pi-desktop:chat:bash', input),
    abortBash: (input) => ipcRenderer.invoke('pi-desktop:chat:abort-bash', input),
    clearQueue: (input) => ipcRenderer.invoke('pi-desktop:chat:clear-queue', input),
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
    warm: (input) => ipcRenderer.invoke('pi-desktop:chat:warm', input),
    readTranscript: (input) => ipcRenderer.invoke('pi-desktop:chat:transcript', input),
    onEvent: subscribe('pi-desktop:chat:event'),
    onReady: subscribe('pi-desktop:chat:ready'),
    onUiRequest: subscribe('pi-desktop:chat:ui-request'),
    onUiResolved: subscribe('pi-desktop:chat:ui-resolved'),
    onExit: subscribe('pi-desktop:chat:exit'),
    onStartupHint: subscribe('pi-desktop:chat:hint')
  },
  checkpoints: {
    create: (input) => ipcRenderer.invoke('pi-desktop:checkpoints:create', input),
    restore: (input) => ipcRenderer.invoke('pi-desktop:checkpoints:restore', input)
  },
  side: {
    open: (input) => ipcRenderer.invoke('pi-desktop:side:open', input),
    send: (input) => ipcRenderer.invoke('pi-desktop:side:send', input),
    abort: (input) => ipcRenderer.invoke('pi-desktop:side:abort', input),
    close: (input) => ipcRenderer.invoke('pi-desktop:side:close', input),
    onEvent: subscribe('pi-desktop:side:event'),
    onExit: subscribe('pi-desktop:side:exit')
  },
  automations: {
    list: () => ipcRenderer.invoke('pi-desktop:automations:list'),
    save: (input) => ipcRenderer.invoke('pi-desktop:automations:save', input),
    delete: (input) => ipcRenderer.invoke('pi-desktop:automations:delete', input),
    runNow: (input) => ipcRenderer.invoke('pi-desktop:automations:run-now', input),
    setSession: (input) => ipcRenderer.invoke('pi-desktop:automations:set-session', input),
    onRun: subscribe('pi-desktop:automations:run'),
    onChanged: subscribe('pi-desktop:automations:changed')
  },
  pr: {
    status: (input) => ipcRenderer.invoke('pi-desktop:pr:status', input),
    failedLog: (input) => ipcRenderer.invoke('pi-desktop:pr:failed-log', input)
  },
  remote: {
    status: () => ipcRenderer.invoke('pi-desktop:remote:status'),
    beginPairing: () => ipcRenderer.invoke('pi-desktop:remote:begin-pairing'),
    cancelPairing: () => ipcRenderer.invoke('pi-desktop:remote:cancel-pairing'),
    revoke: (input) => ipcRenderer.invoke('pi-desktop:remote:revoke', input),
    onChanged: subscribe('pi-desktop:remote:changed')
  },
  catalog: {
    get: () => ipcRenderer.invoke('pi-desktop:catalog:get')
  },
  cua: {
    permissions: () => ipcRenderer.invoke('pi-desktop:cua:permissions'),
    requestPermissions: () =>
      ipcRenderer.invoke('pi-desktop:cua:request-permissions'),
    openSettings: (pane) =>
      ipcRenderer.invoke('pi-desktop:cua:open-settings', { pane }),
    resetPermissions: () => ipcRenderer.invoke('pi-desktop:cua:reset-permissions'),
    pause: () => ipcRenderer.invoke('pi-desktop:cua:pause'),
    resume: () => ipcRenderer.invoke('pi-desktop:cua:resume'),
    stop: () => ipcRenderer.invoke('pi-desktop:cua:stop'),
    onActivity: subscribe('pi-desktop:cua:activity'),
    testActivity: (payload) =>
      ipcRenderer.invoke('pi-desktop:cua:test-activity', payload)
  },
  updates: {
    get: () => ipcRenderer.invoke('pi-desktop:updates:get'),
    checkNow: () => ipcRenderer.invoke('pi-desktop:updates:check-now'),
    open: () => ipcRenderer.invoke('pi-desktop:updates:open'),
    onAvailable: subscribe('pi-desktop:app:update-available')
  },
  dictation: {
    permissions: () => ipcRenderer.invoke('pi-desktop:dictation:permissions'),
    locales: () =>
      ipcRenderer
        .invoke('pi-desktop:dictation:locales')
        .then((r: { locales: string[] }) => r.locales),
    start: (input) => ipcRenderer.invoke('pi-desktop:dictation:start', input),
    stop: () => ipcRenderer.invoke('pi-desktop:dictation:stop'),
    cancel: () => ipcRenderer.invoke('pi-desktop:dictation:cancel'),
    openSettings: (pane) =>
      ipcRenderer.invoke('pi-desktop:dictation:open-settings', { pane }),
    onEvent: subscribe('pi-desktop:dictation:event'),
    testEvent: (payload) =>
      ipcRenderer.invoke('pi-desktop:dictation:test-event', payload)
  }
}

contextBridge.exposeInMainWorld('piDesktop', api)
