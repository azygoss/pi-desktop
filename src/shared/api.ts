import type {
  AgentMessage,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ImageContent,
  Model,
  PiCommandInfo,
  PiEvent,
  PiSessionState,
  PiTreeResult,
  ThinkingLevel
} from './pi-types'
import type { PiRuntimeInfo, PiSettings, ProjectSummary, SessionSummary } from './session-types'

export interface ChatOpenInput {
  chatId: string
  cwd?: string
  sessionPath?: string
}

export interface ChatOpenResult {
  chatId: string
  cwd: string
  state: PiSessionState
  messages: AgentMessage[]
  models: Model[]
  thinkingLevels: ThinkingLevel[]
  commands: PiCommandInfo[]
  /** Absolute session file path reported by pi (pre-allocated for drafts). */
  sessionPath?: string
}

/** File-derived transcript of a past session (instant, before pi is up). */
export interface ChatTranscriptResult {
  messages: AgentMessage[]
  /** True when the active branch has more messages than were returned. */
  hasEarlier: boolean
  totalMessages: number
}

/**
 * Broadcast when a chat's pi process answered its first requests — the
 * live catalog replacing whatever cached values were shown during startup.
 */
export interface ChatReadyPayload {
  chatId: string
  state: PiSessionState
  models: Model[]
  thinkingLevels: ThinkingLevel[]
  commands: PiCommandInfo[]
  sessionPath?: string
  /** Spawn → first answered request, in ms. */
  startupMs: number
}

/** Last-known pi catalog persisted in userData (see catalog-cache.ts). */
export interface CatalogSnapshot {
  models: Model[]
  commands: PiCommandInfo[]
  thinkingLevels: ThinkingLevel[]
  model: Model | null
  thinkingLevel: ThinkingLevel | null
  /** Last measured spawn→ready time, in ms. */
  lastStartupMs?: number
}

export type ChatSendMode = 'prompt' | 'steer' | 'followUp'

export interface ChatSendInput {
  chatId: string
  message: string
  images?: ImageContent[]
  mode: ChatSendMode
}

export interface ChatEventPayload {
  chatId: string
  /**
   * Ordered event batch — main coalesces message_update deltas into one IPC
   * payload per ~16ms; non-delta events flush immediately, so sequence is
   * always preserved.
   */
  events: PiEvent[]
}

export interface ChatUiRequestPayload {
  chatId: string
  request: ExtensionUiRequest
}

export interface ChatExitPayload {
  chatId: string
  code: number | null
  signal: string | null
  /** Last stderr lines (bounded, no RPC payloads). */
  stderrTail: string[]
}

export interface ChatSessionStats {
  sessionFile?: string
  sessionId?: string
  userMessages?: number
  assistantMessages?: number
  toolCalls?: number
  toolResults?: number
  totalMessages?: number
  tokens?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  cost?: number
  contextUsage?: {
    tokens: number | null
    contextWindow: number | null
    percent: number | null
  }
}

export type ChatUiResponseInput = Omit<ExtensionUiResponse, 'type'> & { chatId: string }

/** Result of switching models: pi may clamp the thinking level, so the
 *  post-switch state and the new model's level list come back together. */
export interface SetModelResult {
  model: Model | null
  thinkingLevel: ThinkingLevel | null
  thinkingLevels: ThinkingLevel[]
}

/** A project the user added explicitly (may have no sessions yet). */
export interface AppProject {
  cwd: string
  addedAt: string
}

/** Pi Desktop's own settings (stored in Electron userData, not ~/.pi). */
export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  displayName?: string
  defaultCwd?: string
  piRuntime: {
    mode: 'auto' | 'installed' | 'bundled' | 'custom'
    customPath?: string
  }
  projects: AppProject[]
  hiddenProjects: string[]
  collapsedProjects: string[]
  sidebarCollapsed: boolean
  /** Right panel open state and pixel width, persisted across restarts. */
  panelOpen: boolean
  panelWidth: number
}

/** Identifiers returned by the native context menu. */
export type SessionMenuAction = 'rename' | 'export' | 'reveal' | 'copy-path' | 'delete'
export type ProjectMenuAction = 'reveal' | 'new-chat' | 'hide'
export type ChatMenuAction = 'rename' | 'export' | 'clone' | 'reveal' | 'delete'

export interface ForkMessage {
  entryId: string
  text: string
}

/** How a terminal tab's child env is assembled in the main process. */
export type TerminalProfile = 'shell' | 'pi'

export interface TerminalSpawnInput {
  id: string
  cwd: string
  /** Empty/omitted argv spawns the login shell. */
  argv?: string[]
  profile?: TerminalProfile
  /** Text written to the pty once spawned (e.g. '/login\n'). */
  initialInput?: string
  cols?: number
  rows?: number
}

export interface TerminalDataPayload {
  id: string
  data: string
}

export interface TerminalExitPayload {
  id: string
  exitCode: number
  signal?: number
}

/** Spawn info for the resolved pi runtime, for interactive TUI terminals. */
export interface RuntimeCommand {
  command: string
  args: string[]
}

/** Rectangle (CSS px, window-relative) where a browser view should paint. */
export interface BrowserRect {
  x: number
  y: number
  width: number
  height: number
}

/** Per-tab browser state pushed from main to renderer. */
export interface BrowserTabState {
  id: string
  url: string
  title: string
  favicon?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** The agent bridge asks the renderer to show/close a chat's browser tab. */
export interface BrowserAgentTabPayload {
  /** Panel tab id (`agent-<chatId>`); the view exists in main already. */
  id: string
  chatId: string
  action: 'open' | 'close'
}

/** Git working-tree diff for the diff panel. */
export interface RepoDiffResult {
  isRepo: boolean
  branch?: string
  /** Raw `git diff` output (unified format). */
  diffText: string
  /** Untracked text files (≤200KB each), rendered as all-added files. */
  untracked: { path: string; content: string }[]
}

/** Actions dispatched from the native application menu. */
export type MenuAction = 'open-settings' | 'toggle-sidebar' | 'new-chat'

export interface AppInfo {
  /** App version from the package manifest. */
  version: string
  /** process.platform — used for macOS-only styling (vibrancy, traffic lights). */
  platform: string
  /** Absolute path to the pi agent dir (~/.pi/agent or override). */
  agentDir: string
  /** agentDir with the home directory collapsed to '~' for display. */
  agentDirDisplay: string
  /** Scratch dir for project-less chats (sessions here belong to "Chats"). */
  workspaceDir: string
}

/** Typed API exposed on `window.piDesktop` by the preload script. */
export interface PiDesktopApi {
  runtime: {
    info(): Promise<PiRuntimeInfo>
    /** Re-run runtime detection (applies to newly opened chats). */
    refresh(): Promise<PiRuntimeInfo>
    /** Spawn info (command + args) for interactive pi TUI terminals. */
    command(): Promise<RuntimeCommand>
  }
  sessions: {
    list(): Promise<SessionSummary[]>
    /** Subscribe to session-index changes; returns an unsubscribe function. */
    onChanged(callback: () => void): () => void
    /** Rename via pi's set_session_name (works on closed sessions too). */
    rename(input: { sessionPath: string; name: string }): Promise<void>
    /** Export a session to an HTML file at outputPath. */
    exportHtml(input: { sessionPath: string; outputPath: string }): Promise<{ path?: string }>
    /** Export a session: '.jsonl' output copies the file, otherwise HTML. */
    exportFile(input: { sessionPath: string; outputPath: string }): Promise<{ path?: string }>
    /** Import a .jsonl session file into pi's session dir; returns its path. */
    import(input: { path: string }): Promise<{ sessionPath: string }>
    /** Move a session file to the OS trash (never unlink). */
    delete(input: { sessionPath: string }): Promise<void>
    /** Native context menu for a session row; resolves to the action or null. */
    showMenu(input: { sessionPath: string }): Promise<SessionMenuAction | null>
  }
  terminal: {
    spawn(input: TerminalSpawnInput): Promise<{ id: string }>
    write(input: { id: string; data: string }): Promise<void>
    resize(input: { id: string; cols: number; rows: number }): Promise<void>
    kill(input: { id: string }): Promise<void>
    onData(callback: (payload: TerminalDataPayload) => void): () => void
    onExit(callback: (payload: TerminalExitPayload) => void): () => void
  }
  browser: {
    /** Create a browser tab's WebContentsView; optionally navigates. */
    create(input: { id: string; url?: string }): Promise<void>
    /** Navigate; url is normalized in main. Errors are thrown. */
    navigate(input: { id: string; url: string }): Promise<void>
    goBack(input: { id: string }): Promise<void>
    goForward(input: { id: string }): Promise<void>
    /** Reload, or stop if a load is in flight. */
    reloadOrStop(input: { id: string }): Promise<void>
    close(input: { id: string }): Promise<void>
    /**
     * Which browser tab should be painted and where (window-relative CSS px).
     * `id: null` hides all browser views.
     */
    setVisible(input: { id: string | null; rect?: BrowserRect }): Promise<void>
    /** Hide/show all browser views while a DOM overlay is open. */
    setOverlayOpen(input: { open: boolean }): Promise<void>
    /** Tab state updates (url, title, favicon, loading, history flags). */
    onState(callback: (state: BrowserTabState) => void): () => void
    /** Page asked to open a new window → renderer opens a new browser tab. */
    onOpenUrl(callback: (payload: { url: string }) => void): () => void
    /** A download completed → renderer shows a toast. */
    onDownload(callback: (payload: { filename: string }) => void): () => void
    /** A chat's agent used its browser tools → show or close its tab. */
    onAgentTab(callback: (payload: BrowserAgentTabPayload) => void): () => void
  }
  diff: {
    /** Git status + unified diff for a directory; isRepo=false when not git. */
    status(input: { cwd: string }): Promise<RepoDiffResult>
  }
  projects: {
    list(): Promise<ProjectSummary[]>
    /** Register a project folder (picked via native dialog) in app settings. */
    add(input: { cwd: string }): Promise<void>
    /** Native context menu for a project row; resolves to the action or null. */
    showMenu(input: { cwd: string }): Promise<ProjectMenuAction | null>
  }
  settings: {
    /** Pi's own whitelisted settings (~/.pi/agent/settings.json). */
    get(): Promise<PiSettings>
  }
  appSettings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  app: {
    getUserFirstName(): Promise<string>
    /** Native folder picker; resolves to the chosen absolute path or null. */
    pickFolder(): Promise<string | null>
    /** Native file picker for a single existing file (used for custom paths). */
    pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>
    /** Native save dialog; resolves to the chosen path or null. */
    saveFile(input: { defaultPath?: string; extension: string }): Promise<string | null>
    /** Reveal a path in the OS file manager. */
    revealPath(path: string): Promise<void>
    /** Native confirm/message dialog; resolves to the clicked button index. */
    confirmDialog(input: {
      title: string
      message?: string
      buttons: string[]
      danger?: boolean
    }): Promise<number>
    /** App version and pi agent directory info for the settings/about panes. */
    getAppInfo(): Promise<AppInfo>
    /** Open the pi agent directory in the OS file manager. */
    openAgentDir(): Promise<void>
    /** Open an http(s) URL in the system browser. */
    openExternal(url: string): Promise<void>
    /** Quit the app (renderer confirms with the user first when needed). */
    quit(): Promise<void>
    /** Native application menu actions; returns an unsubscribe function. */
    onMenuAction(callback: (action: MenuAction) => void): () => void
  }
  chat: {
    open(input: ChatOpenInput): Promise<ChatOpenResult>
    send(input: ChatSendInput): Promise<void>
    abort(input: { chatId: string }): Promise<void>
    setModel(input: { chatId: string; provider: string; modelId: string }): Promise<SetModelResult>
    setThinkingLevel(input: { chatId: string; level: ThinkingLevel }): Promise<void>
    getStats(input: { chatId: string }): Promise<ChatSessionStats | undefined>
    setCwd(input: { chatId: string; cwd: string }): Promise<ChatOpenResult>
    compact(input: { chatId: string; customInstructions?: string }): Promise<void>
    setSessionName(input: { chatId: string; name: string }): Promise<void>
    exportHtml(input: { chatId: string; outputPath: string }): Promise<{ path?: string }>
    /** Re-fetch state/messages/models for an open chat (after fork/clone). */
    refresh(input: { chatId: string }): Promise<ChatOpenResult>
    getForkMessages(input: { chatId: string }): Promise<{ messages: ForkMessage[] }>
    fork(input: { chatId: string; entryId: string }): Promise<{ text?: string; cancelled?: boolean }>
    clone(input: { chatId: string }): Promise<{ cancelled?: boolean }>
    /** Restart the chat's pi process on the same session (reloads resources). */
    reload(input: { chatId: string }): Promise<ChatOpenResult>
    /** Session entry tree for the /tree modal. */
    getTree(input: { chatId: string }): Promise<PiTreeResult>
    /** Text of the last assistant message (for /copy). */
    getLastAssistantText(input: { chatId: string }): Promise<{ text: string | null }>
    /** chatId of the open chat viewing a session path, if any. */
    chatIdForSession(input: { sessionPath: string }): Promise<string | undefined>
    /** Native context menu for the chat header; resolves to the action or null. */
    showMenu(input: { chatId: string }): Promise<ChatMenuAction | null>
    respondUi(input: ChatUiResponseInput): Promise<void>
    close(input: { chatId: string }): Promise<void>
    /** Mark a chat as currently visible (idle eviction bookkeeping). */
    focus(input: { chatId: string }): Promise<void>
    /** File-derived transcript of a session (renders before pi is ready). */
    readTranscript(input: {
      sessionPath: string
      limit?: number
    }): Promise<ChatTranscriptResult>
    onEvent(callback: (payload: ChatEventPayload) => void): () => void
    /** Live catalog/state once a chat's pi process answered. */
    onReady(callback: (payload: ChatReadyPayload) => void): () => void
    onUiRequest(callback: (payload: ChatUiRequestPayload) => void): () => void
    onExit(callback: (payload: ChatExitPayload) => void): () => void
  }
  /** Last-known pi catalog for instant composer/palette rendering. */
  catalog: {
    get(): Promise<CatalogSnapshot>
  }
}
