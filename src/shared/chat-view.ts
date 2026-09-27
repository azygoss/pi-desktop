import type {
  AgentMessage,
  AssistantMessage,
  ImageContent,
  PiEvent,
  StopReason,
  TextContent,
  ToolCallContent,
  ToolResultPayload
} from './pi-types'

// ---------------------------------------------------------------------------
// Display model: what the renderer needs from AgentMessage + streaming events
// ---------------------------------------------------------------------------

export type DisplayBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | {
      type: 'toolCall'
      id: string
      name: string
      /** Raw accumulated argument JSON while streaming. */
      argsText?: string
      arguments: Record<string, unknown>
    }
  | { type: 'image'; data: string; mimeType: string }

export type DisplayMessage =
  | {
      kind: 'user'
      key: string
      text: string
      images: ImageContent[]
      /** Sent while pi was still starting; delivered once it is ready. */
      queued?: boolean
      timestamp?: number
    }
  | {
      kind: 'assistant'
      key: string
      blocks: DisplayBlock[]
      stopReason?: StopReason
      errorMessage?: string
      streaming?: boolean
      timestamp?: number
    }
  | {
      kind: 'bash'
      key: string
      command: string
      output: string
      exitCode?: number
      cancelled?: boolean
      timestamp?: number
    }
  | { kind: 'notice'; key: string; text: string; tone: 'info' | 'error'; timestamp?: number }

export interface ToolRun {
  toolCallId: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  partialText?: string
  result?: ToolResultPayload
}

export type ChatStatus = 'starting' | 'idle' | 'streaming' | 'error' | 'exited'

export interface ChatViewState {
  status: ChatStatus
  messages: DisplayMessage[]
  toolRuns: Record<string, ToolRun>
}

export function createChatViewState(): ChatViewState {
  return { status: 'idle', messages: [], toolRuns: {} }
}

let keyCounter = 0
function nextKey(prefix: string): string {
  return `${prefix}-${++keyCounter}`
}

// ---------------------------------------------------------------------------
// AgentMessage → DisplayMessage
// ---------------------------------------------------------------------------

function extractUserContent(content: unknown): { text: string; images: ImageContent[] } {
  if (typeof content === 'string') {
    return { text: content, images: [] }
  }
  const text: string[] = []
  const images: ImageContent[] = []
  if (Array.isArray(content)) {
    for (const block of content as (TextContent | ImageContent)[]) {
      if (block?.type === 'text') {
        text.push(block.text)
      } else if (block?.type === 'image') {
        images.push(block)
      }
    }
  }
  return { text: text.join('\n'), images }
}

function assistantBlocks(message: AssistantMessage): DisplayBlock[] {
  const blocks: DisplayBlock[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'thinking') {
      blocks.push({ type: 'thinking', thinking: block.thinking })
    } else if (block.type === 'toolCall') {
      const call = block as ToolCallContent
      blocks.push({ type: 'toolCall', id: call.id, name: call.name, arguments: call.arguments })
    }
  }
  return blocks
}

/**
 * Convert a persisted/streamed AgentMessage into a DisplayMessage. Returns
 * null for messages that only update tool runs (toolResult) — those are
 * handled separately via `applyAgentMessage`.
 */
export function mapAgentMessage(message: AgentMessage, key?: string): DisplayMessage | null {
  const k = key ?? nextKey('msg')
  switch (message.role) {
    case 'user': {
      const { text, images } = extractUserContent(message.content)
      return { kind: 'user', key: k, text, images, timestamp: message.timestamp }
    }
    case 'assistant':
      return {
        kind: 'assistant',
        key: k,
        blocks: assistantBlocks(message),
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
        timestamp: message.timestamp
      }
    case 'bashExecution':
      return {
        kind: 'bash',
        key: k,
        command: message.command,
        output: message.output,
        exitCode: message.exitCode,
        cancelled: message.cancelled,
        timestamp: message.timestamp
      }
    case 'toolResult':
      return null
    case 'compactionSummary':
      return { kind: 'notice', key: k, text: 'Context compacted', tone: 'info' }
    case 'branchSummary':
      return { kind: 'notice', key: k, text: 'Branched with summary', tone: 'info' }
    case 'custom':
      return message.display
        ? {
            kind: 'notice',
            key: k,
            text:
              typeof message.content === 'string'
                ? message.content
                : extractUserContent(message.content).text,
            tone: 'info'
          }
        : null
    default:
      return null
  }
}

/** Fold a persisted toolResult message into the matching tool run. */
function applyToolResult(state: ChatViewState, message: AgentMessage): void {
  if (message.role !== 'toolResult') {
    return
  }
  const run = state.toolRuns[message.toolCallId] ?? {
    toolCallId: message.toolCallId,
    name: message.toolName,
    args: {},
    status: 'done' as const
  }
  run.status = message.isError ? 'error' : 'done'
  run.result = { content: message.content, details: message.details }
  state.toolRuns[message.toolCallId] = run
}

/** Rebuild view state from a persisted `get_messages` list. */
export function buildChatViewState(messages: AgentMessage[]): ChatViewState {
  const state = createChatViewState()
  for (const message of messages) {
    if (message.role === 'toolResult') {
      applyToolResult(state, message)
      continue
    }
    const display = mapAgentMessage(message)
    if (display) {
      state.messages.push(display)
    }
  }
  return state
}

// ---------------------------------------------------------------------------
// Streaming reducer
// ---------------------------------------------------------------------------

function lastMessage(state: ChatViewState): DisplayMessage | undefined {
  return state.messages[state.messages.length - 1]
}

function streamingAssistant(state: ChatViewState): Extract<DisplayMessage, { kind: 'assistant' }> {
  const last = lastMessage(state)
  if (last?.kind === 'assistant' && last.streaming) {
    return last
  }
  const fresh: Extract<DisplayMessage, { kind: 'assistant' }> = {
    kind: 'assistant',
    key: nextKey('stream'),
    blocks: [],
    streaming: true
  }
  state.messages.push(fresh)
  return fresh
}

function ensureBlock(
  message: Extract<DisplayMessage, { kind: 'assistant' }>,
  contentIndex: number,
  make: () => DisplayBlock
): DisplayBlock {
  const existing = message.blocks[contentIndex]
  if (existing) {
    return existing
  }
  const block = make()
  message.blocks[contentIndex] = block
  return block
}

function applyAssistantDelta(
  state: ChatViewState,
  event: NonNullable<Extract<PiEvent, { type: 'message_update' }>['assistantMessageEvent']>
): void {
  const message = streamingAssistant(state)
  const idx = event.contentIndex
  switch (event.type) {
    case 'text_start':
      ensureBlock(message, idx, () => ({ type: 'text', text: '' }))
      break
    case 'text_delta': {
      const block = ensureBlock(message, idx, () => ({ type: 'text', text: '' }))
      if (block.type === 'text') {
        block.text += event.delta
      }
      break
    }
    case 'text_end': {
      const block = ensureBlock(message, idx, () => ({ type: 'text', text: '' }))
      if (block.type === 'text') {
        block.text = event.content
      }
      break
    }
    case 'thinking_start':
      ensureBlock(message, idx, () => ({ type: 'thinking', thinking: '' }))
      break
    case 'thinking_delta': {
      const block = ensureBlock(message, idx, () => ({ type: 'thinking', thinking: '' }))
      if (block.type === 'thinking') {
        block.thinking += event.delta
      }
      break
    }
    case 'thinking_end': {
      const block = ensureBlock(message, idx, () => ({ type: 'thinking', thinking: '' }))
      if (block.type === 'thinking') {
        block.thinking = event.content
      }
      break
    }
    case 'toolcall_start':
      ensureBlock(message, idx, () => ({
        type: 'toolCall',
        id: event.id,
        name: event.toolName,
        argsText: '',
        arguments: {}
      }))
      break
    case 'toolcall_delta': {
      const block = ensureBlock(message, idx, () => ({
        type: 'toolCall',
        id: `call_${idx}`,
        name: '',
        argsText: '',
        arguments: {}
      }))
      if (block.type === 'toolCall') {
        block.argsText = (block.argsText ?? '') + event.delta
      }
      break
    }
    case 'toolcall_end': {
      message.blocks[idx] = {
        type: 'toolCall',
        id: event.toolCall.id,
        name: event.toolCall.name,
        arguments: event.toolCall.arguments
      }
      break
    }
  }
}

/** Push a display message, deduping user echoes of optimistic local sends. */
function pushDeduped(state: ChatViewState, display: DisplayMessage): void {
  const last = lastMessage(state)
  if (display.kind === 'user' && last?.kind === 'user' && last.text === display.text) {
    state.messages[state.messages.length - 1] = { ...display, key: last.key }
    return
  }
  state.messages.push(display)
}

function pushNotice(state: ChatViewState, text: string, tone: 'info' | 'error' = 'info'): void {
  state.messages.push({ kind: 'notice', key: nextKey('notice'), text, tone })
}

/**
 * Apply one pi event to the chat view state (mutates `state`). Callers should
 * batch events per animation frame and publish a fresh reference afterwards.
 * Returns true when session stats should be re-fetched (agent_end).
 */
export function reducePiEvent(state: ChatViewState, event: PiEvent): boolean {
  switch (event.type) {
    case 'agent_start':
      state.status = 'streaming'
      return false

    case 'agent_end':
      // willRetry means another run follows; agent_settled ends the turn.
      for (const message of event.messages ?? []) {
        if (message.role === 'toolResult') {
          applyToolResult(state, message)
        }
      }
      return true

    case 'agent_settled':
      state.status = 'idle'
      return false

    case 'message_start': {
      const display = mapAgentMessage(event.message)
      if (display) {
        if (display.kind === 'assistant') {
          display.streaming = true
        }
        pushDeduped(state, display)
      }
      return false
    }

    case 'message_update':
      applyAssistantDelta(state, event.assistantMessageEvent)
      return false

    case 'message_end': {
      const display = mapAgentMessage(event.message)
      if (!display) {
        // message_end for a toolResult only updates the run.
        applyToolResult(state, event.message)
        return false
      }
      const last = lastMessage(state)
      if (last?.kind === 'assistant' && last.streaming && display.kind === 'assistant') {
        // The authoritative final message replaces the assembled stream.
        state.messages[state.messages.length - 1] = { ...display, key: last.key }
      } else if (display.kind === 'user' && last?.kind === 'user' && last.text === display.text) {
        // Echo of an optimistically appended user message: keep our key.
        state.messages[state.messages.length - 1] = { ...display, key: last.key }
      } else {
        state.messages.push(display)
      }
      return false
    }

    case 'tool_execution_start':
      state.toolRuns[event.toolCallId] = {
        toolCallId: event.toolCallId,
        name: event.toolName,
        args: event.args,
        status: 'running'
      }
      return false

    case 'tool_execution_update': {
      const run = state.toolRuns[event.toolCallId]
      const partialText = event.partialResult?.content
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (run) {
        run.partialText = partialText ?? run.partialText
      } else {
        state.toolRuns[event.toolCallId] = {
          toolCallId: event.toolCallId,
          name: event.toolName,
          args: event.args,
          status: 'running',
          partialText
        }
      }
      return false
    }

    case 'tool_execution_end': {
      const run = state.toolRuns[event.toolCallId] ?? {
        toolCallId: event.toolCallId,
        name: event.toolName,
        args: {},
        status: 'done' as const
      }
      run.status = event.isError ? 'error' : 'done'
      run.result = event.result
      run.partialText = undefined
      state.toolRuns[event.toolCallId] = run
      return false
    }

    case 'bash_execution_update':
      return false

    case 'compaction_start':
      pushNotice(state, 'Compacting context…')
      return false

    case 'compaction_end':
      pushNotice(
        state,
        event.aborted
          ? 'Compaction aborted'
          : event.result
            ? 'Context compacted'
            : `Compaction failed${event.errorMessage ? `: ${event.errorMessage}` : ''}`,
        event.aborted || event.result ? 'info' : 'error'
      )
      return false

    case 'auto_retry_start':
      pushNotice(state, `Retrying (${event.attempt}/${event.maxAttempts})…`)
      return false

    case 'auto_retry_end':
      if (!event.success) {
        pushNotice(state, `Retry failed: ${event.finalError ?? 'unknown error'}`, 'error')
      }
      return false

    case 'summarization_retry_scheduled':
      pushNotice(state, `Summarization retry scheduled (${event.attempt}/${event.maxAttempts})`)
      return false

    case 'extension_error':
      pushNotice(state, `Extension error: ${event.error}`, 'error')
      return false

    case 'extension_ui_request':
      if (event.method === 'notify') {
        pushNotice(state, event.message, event.notifyType === 'error' ? 'error' : 'info')
      }
      return false

    default:
      return false
  }
}
