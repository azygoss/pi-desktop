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

export type ChatSendMode = 'prompt' | 'steer' | 'followUp'

export interface ChatSendInput {
  chatId: string
  message: string
  images?: ImageContent[]
  mode: ChatSendMode
}

export interface ChatEventPayload {
  chatId: string
  event: PiEvent
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

/** Actions dispatched from the native application menu. */
export type MenuAction = 'open-settings' | 'toggle-sidebar' | 'new-chat'

export interface AppInfo {
  /** App version from the package manifest. */
  version: string
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
    onEvent(callback: (payload: ChatEventPayload) => void): () => void
    onUiRequest(callback: (payload: ChatUiRequestPayload) => void): () => void
    onExit(callback: (payload: ChatExitPayload) => void): () => void
  }
}
