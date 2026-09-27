// Types for the `pi --mode rpc` JSONL protocol and pi session files.
// Based on docs/rpc.md and docs/session-format.md shipped with
// @earendil-works/pi-coding-agent.

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type QueueMode = 'all' | 'one-at-a-time'

export type StreamingBehavior = 'steer' | 'followUp'

export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'pending'

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextContent {
  type: 'text'
  text: string
}

export interface ThinkingContent {
  type: 'thinking'
  thinking: string
}

export interface ToolCallContent {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ImageContent {
  type: 'image'
  /** base64-encoded image data */
  data: string
  mimeType: string
}

// ---------------------------------------------------------------------------
// Messages (AgentMessage union)
// ---------------------------------------------------------------------------

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens?: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

export interface Attachment {
  id: string
  type: string
  fileName?: string
  mimeType?: string
  size?: number
  content?: string
  extractedText?: string | null
  preview?: string | null
}

export interface UserMessage {
  role: 'user'
  content: string | (TextContent | ImageContent)[]
  timestamp: number
  attachments?: Attachment[]
}

export interface AssistantMessage {
  role: 'assistant'
  content: (TextContent | ThinkingContent | ToolCallContent)[]
  api: string
  provider: string
  model: string
  usage: Usage
  stopReason: StopReason
  errorMessage?: string
  timestamp: number
}

export interface ToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: (TextContent | ImageContent)[]
  details?: unknown
  usage?: Usage
  isError: boolean
  timestamp: number
}

export interface BashExecutionMessage {
  role: 'bashExecution'
  command: string
  output: string
  exitCode?: number
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string | null
  excludeFromContext?: boolean
  timestamp: number
}

export interface CustomMessage {
  role: 'custom'
  customType: string
  content: string | (TextContent | ImageContent)[]
  display: boolean
  details?: unknown
  timestamp: number
}

export interface BranchSummaryMessage {
  role: 'branchSummary'
  summary: string
  fromId: string
  timestamp: number
}

export interface CompactionSummaryMessage {
  role: 'compactionSummary'
  summary: string
  tokensBefore: number
  timestamp: number
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface ModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * Maps pi thinking levels to provider/model-specific values. Missing keys
 * use provider defaults; null marks a level as unsupported.
 */
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>

export interface Model {
  id: string
  name: string
  api: string
  provider: string
  baseUrl: string
  reasoning: boolean
  thinkingLevelMap?: ThinkingLevelMap
  input: string[]
  contextWindow: number
  maxTokens: number
  cost: ModelCost
}

// ---------------------------------------------------------------------------
// Commands (stdin)
// ---------------------------------------------------------------------------

interface CommandBase {
  id?: string
}

export type PiRpcCommand =
  | (CommandBase & {
      type: 'prompt'
      message: string
      images?: ImageContent[]
      streamingBehavior?: StreamingBehavior
    })
  | (CommandBase & { type: 'steer'; message: string; images?: ImageContent[] })
  | (CommandBase & { type: 'follow_up'; message: string; images?: ImageContent[] })
  | (CommandBase & { type: 'abort' })
  | (CommandBase & { type: 'clear_queue' })
  | (CommandBase & { type: 'new_session'; parentSession?: string })
  | (CommandBase & { type: 'get_state' })
  | (CommandBase & { type: 'get_messages' })
  | (CommandBase & { type: 'set_model'; provider: string; modelId: string })
  | (CommandBase & { type: 'cycle_model' })
  | (CommandBase & { type: 'get_available_models' })
  | (CommandBase & { type: 'set_thinking_level'; level: ThinkingLevel })
  | (CommandBase & { type: 'cycle_thinking_level' })
  | (CommandBase & { type: 'get_available_thinking_levels' })
  | (CommandBase & { type: 'set_steering_mode'; mode: QueueMode })
  | (CommandBase & { type: 'set_follow_up_mode'; mode: QueueMode })
  | (CommandBase & { type: 'compact'; customInstructions?: string })
  | (CommandBase & { type: 'set_auto_compaction'; enabled: boolean })
  | (CommandBase & { type: 'set_auto_retry'; enabled: boolean })
  | (CommandBase & { type: 'abort_retry' })
  | (CommandBase & { type: 'bash'; command: string })
  | (CommandBase & { type: 'abort_bash' })
  | (CommandBase & { type: 'get_session_stats' })
  | (CommandBase & { type: 'export_html'; outputPath?: string })
  | (CommandBase & { type: 'switch_session'; sessionPath: string })
  | (CommandBase & { type: 'fork'; entryId: string })
  | (CommandBase & { type: 'clone' })
  | (CommandBase & { type: 'get_fork_messages' })
  | (CommandBase & { type: 'get_entries'; since?: string })
  | (CommandBase & { type: 'get_tree' })
  | (CommandBase & { type: 'get_last_assistant_text' })
  | (CommandBase & { type: 'set_session_name'; name: string })
  | (CommandBase & { type: 'get_commands' })

export type PiRpcCommandType = PiRpcCommand['type']

// ---------------------------------------------------------------------------
// Responses (stdout)
// ---------------------------------------------------------------------------

export interface PiRpcResponse<T = unknown> {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: T
  error?: string
}

// ---------------------------------------------------------------------------
// Response payloads
// ---------------------------------------------------------------------------

export interface PiSessionState {
  model: Model | null
  thinkingLevel: ThinkingLevel
  isStreaming: boolean
  isCompacting: boolean
  steeringMode: QueueMode
  followUpMode: QueueMode
  sessionFile?: string | null
  sessionId: string
  sessionName?: string
  autoCompactionEnabled: boolean
  messageCount: number
  pendingMessageCount: number
}

export interface PiCommandInfo {
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill'
  location?: 'user' | 'project' | 'path'
  path?: string
}

// ---------------------------------------------------------------------------
// Events (stdout)
// ---------------------------------------------------------------------------

export type AssistantMessageEvent =
  | { type: 'text_start'; contentIndex: number }
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'text_end'; contentIndex: number; content: string }
  | { type: 'thinking_start'; contentIndex: number }
  | { type: 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_end'; contentIndex: number; content: string }
  | { type: 'toolcall_start'; contentIndex: number; id: string; toolName: string }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCallContent }

export interface ToolResultPayload {
  content: (TextContent | ImageContent)[]
  details?: unknown
}

export interface CompactionResult {
  summary: string
  firstKeptEntryId?: string
  tokensBefore: number
  estimatedTokensAfter?: number
  usage?: Usage
  details?: unknown
}

export type ExtensionUiRequest =
  | {
      type: 'extension_ui_request'
      id: string
      method: 'select'
      title?: string
      options: string[]
      timeout?: number
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'confirm'
      title?: string
      message?: string
      timeout?: number
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'input'
      title?: string
      placeholder?: string
      timeout?: number
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'editor'
      title?: string
      prefill?: string
      timeout?: number
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'notify'
      message: string
      notifyType?: 'info' | 'warning' | 'error'
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'setStatus'
      statusKey: string
      statusText?: string
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'setWidget'
      widgetKey: string
      widgetLines?: string[]
      widgetPlacement?: 'aboveEditor' | 'belowEditor'
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'setTitle'
      title: string
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'set_editor_text'
      text: string
    }

export interface ExtensionUiResponse {
  type: 'extension_ui_response'
  id: string
  value?: string
  confirmed?: boolean
  cancelled?: boolean
}

export type PiEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[]; willRetry?: boolean }
  | { type: 'agent_settled' }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; usage?: Usage; assistantMessageEvent: AssistantMessageEvent }
  | { type: 'message_end'; message: AgentMessage }
  | { type: 'bash_execution_update'; id?: string; delta: string }
  | {
      type: 'tool_execution_start'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
    }
  | {
      type: 'tool_execution_update'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      partialResult: ToolResultPayload
    }
  | {
      type: 'tool_execution_end'
      toolCallId: string
      toolName: string
      result: ToolResultPayload
      isError: boolean
    }
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  | { type: 'compaction_start'; reason: 'manual' | 'threshold' | 'overflow' }
  | {
      type: 'compaction_end'
      reason: 'manual' | 'threshold' | 'overflow'
      result: CompactionResult | null
      aborted: boolean
      willRetry?: boolean
      errorMessage?: string
    }
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number; delayMs: number; errorMessage?: string }
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string }
  | {
      type: 'summarization_retry_scheduled'
      attempt: number
      maxAttempts: number
      delayMs: number
      errorMessage?: string
    }
  | {
      type: 'summarization_retry_attempt_start'
      source: 'compaction' | 'branchSummary'
      reason?: 'manual' | 'threshold' | 'overflow'
    }
  | { type: 'summarization_retry_finished' }
  | { type: 'extension_error'; extensionPath: string; event?: string; error: string }
  | ExtensionUiRequest

// ---------------------------------------------------------------------------
// Session file entries (session-format.md)
// ---------------------------------------------------------------------------

export interface SessionHeader {
  type: 'session'
  version: number
  id: string
  timestamp: string
  cwd: string
  parentSession?: string
}
