import type {
  AgentMessage,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ImageContent,
  Model,
  PiCommandInfo,
  PiEvent,
  PiSessionState,
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

/** Typed API exposed on `window.piDesktop` by the preload script. */
export interface PiDesktopApi {
  runtime: {
    info(): Promise<PiRuntimeInfo>
  }
  sessions: {
    list(): Promise<SessionSummary[]>
    /** Subscribe to session-index changes; returns an unsubscribe function. */
    onChanged(callback: () => void): () => void
  }
  projects: {
    list(): Promise<ProjectSummary[]>
  }
  settings: {
    get(): Promise<PiSettings>
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
  }
  chat: {
    open(input: ChatOpenInput): Promise<ChatOpenResult>
    send(input: ChatSendInput): Promise<void>
    abort(input: { chatId: string }): Promise<void>
    setModel(input: { chatId: string; provider: string; modelId: string }): Promise<void>
    setThinkingLevel(input: { chatId: string; level: ThinkingLevel }): Promise<void>
    getStats(input: { chatId: string }): Promise<ChatSessionStats | undefined>
    setCwd(input: { chatId: string; cwd: string }): Promise<ChatOpenResult>
    compact(input: { chatId: string; customInstructions?: string }): Promise<void>
    setSessionName(input: { chatId: string; name: string }): Promise<void>
    exportHtml(input: { chatId: string; outputPath: string }): Promise<{ path?: string }>
    respondUi(input: ChatUiResponseInput): Promise<void>
    close(input: { chatId: string }): Promise<void>
    onEvent(callback: (payload: ChatEventPayload) => void): () => void
    onUiRequest(callback: (payload: ChatUiRequestPayload) => void): () => void
    onExit(callback: (payload: ChatExitPayload) => void): () => void
  }
}
