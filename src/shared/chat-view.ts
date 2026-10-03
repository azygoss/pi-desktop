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
  | {
      type: 'thinking'
      thinking: string
      /** Live streams: wall-clock when thinking_start arrived. */
      startedAt?: number
      /** thinking_end minus startedAt; persisted sessions leave it unset. */
      durationMs?: number
    }
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
      /** pi's model id that produced this message (persisted sessions). */
      model?: string
      /** Tokens and cost of the request that produced this message. */
      usage?: { input: number; output: number; cost: number }
    }
  | {
      kind: 'bash'
      key: string
      command: string
      output: string
      exitCode?: number
      cancelled?: boolean
      /** A `!command` still running; output grows with bash_execution_update. */
      running?: boolean
      timestamp?: number
    }
  | {
      kind: 'notice'
      key: string
      text: string
      tone: 'info' | 'error'
      /** Longer text behind the notice (a compaction summary). */
      detail?: string
      timestamp?: number
    }

export interface ToolRun {
  toolCallId: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  /** Wall-clock at tool_execution_start (live runs only), for elapsed time. */
  startedAt?: number
  /** tool_execution_end minus startedAt (live runs only). */
  durationMs?: number
  partialText?: string
  result?: ToolResultPayload
}

export type ChatStatus = 'starting' | 'idle' | 'streaming' | 'error' | 'exited'

export interface ChatViewState {
  status: ChatStatus
  messages: DisplayMessage[]
  toolRuns: Record<string, ToolRun>
  /** Wall-clock at agent_start of the current run; cleared when it settles. */
  runStartedAt?: number
  /** Messages waiting in pi's steering / follow-up queues (queue_update). */
  queue?: MessageQueue
}

export interface MessageQueue {
  steering: string[]
  followUp: string[]
}

export function queueLength(queue: MessageQueue | undefined): number {
  return queue ? queue.steering.length + queue.followUp.length : 0
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
        timestamp: message.timestamp,
        model: message.model,
        ...(message.usage
          ? {
              usage: {
                input:
                  (message.usage.input ?? 0) +
                  (message.usage.cacheRead ?? 0) +
                  (message.usage.cacheWrite ?? 0),
                output: message.usage.output ?? 0,
                cost: message.usage.cost?.total ?? 0
              }
            }
          : {})
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
      return {
        kind: 'notice',
        key: k,
        text: compactedLabel(message.tokensBefore),
        tone: 'info',
        ...(message.summary ? { detail: message.summary } : {})
      }
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

/** Arguments of a tool call already in the transcript (newest first). */
function findCallArgs(state: ChatViewState, id: string): Record<string, unknown> | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const message = state.messages[i]!
    if (message.kind !== 'assistant') {
      continue
    }
    for (const block of message.blocks) {
      if (block.type === 'toolCall' && block.id === id) {
        return block.arguments
      }
    }
  }
  return undefined
}

/**
 * Fold a persisted toolResult message into the matching tool run. `args`
 * comes from the assistant message's toolCall block: the result alone does
 * not carry them, and without them a reopened session shows bare tool names.
 */
function applyToolResult(
  state: ChatViewState,
  message: AgentMessage,
  args?: Record<string, unknown>
): void {
  if (message.role !== 'toolResult') {
    return
  }
  const run = state.toolRuns[message.toolCallId] ?? {
    toolCallId: message.toolCallId,
    name: message.toolName,
    args: args ?? findCallArgs(state, message.toolCallId) ?? {},
    status: 'done' as const
  }
  // Replace rather than mutate: memoized tool cards skip identical runs.
  state.toolRuns[message.toolCallId] = {
    ...run,
    status: message.isError ? 'error' : 'done',
    result: { content: message.content, details: message.details }
  }
}

/** Rebuild view state from a persisted `get_messages` list. */
export function buildChatViewState(messages: AgentMessage[]): ChatViewState {
  const state = createChatViewState()
  const callArgs = new Map<string, Record<string, unknown>>()
  for (const message of messages) {
    if (message.role === 'toolResult') {
      applyToolResult(state, message, callArgs.get(message.toolCallId))
      continue
    }
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'toolCall') {
          const call = block as ToolCallContent
          callArgs.set(call.id, call.arguments)
        }
      }
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

/**
 * Swap `prev` for `next` in the message list. Streaming updates replace the
 * message object instead of mutating it so React.memo rows can skip
 * unchanged messages by reference.
 */
function replaceMessage(state: ChatViewState, prev: DisplayMessage, next: DisplayMessage): void {
  const index = state.messages.lastIndexOf(prev)
  if (index >= 0) {
    state.messages[index] = next
  }
}

function applyAssistantDelta(
  state: ChatViewState,
  event: NonNullable<Extract<PiEvent, { type: 'message_update' }>['assistantMessageEvent']>
): void {
  const message = streamingAssistant(state)
  const idx = event.contentIndex
  const existing = message.blocks[idx]
  const replaceBlock = (block: DisplayBlock): void => {
    if (block === existing) {
      return
    }
    const blocks = message.blocks.slice()
    blocks[idx] = block
    replaceMessage(state, message, { ...message, blocks })
  }
  switch (event.type) {
    case 'text_start':
      if (!existing) {
        replaceBlock({ type: 'text', text: '' })
      }
      break
    case 'text_delta':
      replaceBlock({
        type: 'text',
        text: (existing?.type === 'text' ? existing.text : '') + event.delta
      })
      break
    case 'text_end':
      replaceBlock({ type: 'text', text: event.content })
      break
    case 'thinking_start':
      if (!existing) {
        replaceBlock({ type: 'thinking', thinking: '', startedAt: Date.now() })
      }
      break
    case 'thinking_delta':
      replaceBlock({
        type: 'thinking',
        thinking: (existing?.type === 'thinking' ? existing.thinking : '') + event.delta,
        startedAt: existing?.type === 'thinking' ? existing.startedAt : undefined
      })
      break
    case 'thinking_end':
      replaceBlock({
        type: 'thinking',
        thinking: event.content,
        durationMs:
          existing?.type === 'thinking' && existing.startedAt !== undefined
            ? Date.now() - existing.startedAt
            : undefined
      })
      break
    case 'toolcall_start':
      replaceBlock({
        type: 'toolCall',
        id: event.id,
        name: event.toolName,
        argsText: '',
        arguments: {}
      })
      break
    case 'toolcall_delta':
      replaceBlock({
        type: 'toolCall',
        id: existing?.type === 'toolCall' ? existing.id : `call_${idx}`,
        name: existing?.type === 'toolCall' ? existing.name : '',
        argsText: (existing?.type === 'toolCall' ? (existing.argsText ?? '') : '') + event.delta,
        arguments: existing?.type === 'toolCall' ? existing.arguments : {}
      })
      break
    case 'toolcall_end':
      replaceBlock({
        type: 'toolCall',
        id: event.toolCall.id,
        name: event.toolCall.name,
        arguments: event.toolCall.arguments
      })
      break
  }
}

/** Push a display message, deduping user echoes of optimistic local sends. */
function pushDeduped(state: ChatViewState, display: DisplayMessage): void {
  const last = lastMessage(state)
  if (display.kind === 'user' && last?.kind === 'user' && last.text === display.text) {
    state.messages[state.messages.length - 1] = { ...display, key: last.key }
    return
  }
  if (display.kind === 'bash' && last?.kind === 'bash' && last.command === display.command) {
    // pi's own record of a `!command` row the app is already showing.
    return
  }
  state.messages.push(display)
}

function compactTokens(n: number): string {
  return n < 1000 ? `${n}` : `${Math.round(n / 1000)}k`
}

/** "Context compacted · 150k → 32k tokens" (sizes when pi reported them). */
function compactedLabel(before?: number, after?: number): string {
  if (typeof before !== 'number' || before <= 0) {
    return 'Context compacted'
  }
  return typeof after === 'number' && after > 0
    ? `Context compacted · ${compactTokens(before)} → ${compactTokens(after)} tokens`
    : `Context compacted · was ${compactTokens(before)} tokens`
}

/** A delivered user message leaves the queue strip (first match only). */
function dequeue(state: ChatViewState, text: string): void {
  const queue = state.queue
  if (!queue) {
    return
  }
  const steerAt = queue.steering.indexOf(text)
  const followAt = steerAt === -1 ? queue.followUp.indexOf(text) : -1
  if (steerAt === -1 && followAt === -1) {
    return
  }
  const steering = queue.steering.filter((_, i) => i !== steerAt)
  const followUp = queue.followUp.filter((_, i) => i !== followAt)
  if (steering.length === 0 && followUp.length === 0) {
    delete state.queue
  } else {
    state.queue = { steering, followUp }
  }
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
      // A retry (agent_end willRetry → agent_start) continues the same run;
      // anything else (incl. a run cut off by a pi exit) starts the clock.
      if (state.status !== 'streaming' || state.runStartedAt === undefined) {
        state.runStartedAt = Date.now()
      }
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
      delete state.runStartedAt
      delete state.queue
      return false

    case 'queue_update':
      if (event.steering.length === 0 && event.followUp.length === 0) {
        delete state.queue
      } else {
        state.queue = { steering: [...event.steering], followUp: [...event.followUp] }
      }
      return false

    case 'message_start': {
      const display = mapAgentMessage(event.message)
      if (display) {
        if (display.kind === 'assistant') {
          display.streaming = true
        }
        if (display.kind === 'user') {
          dequeue(state, display.text)
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
      } else if (
        display.kind === 'bash' &&
        last?.kind === 'bash' &&
        last.command === display.command
      ) {
        // pi's record of a `!command` the app already shows: keep our row.
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
        status: 'running',
        startedAt: Date.now()
      }
      return false

    case 'tool_execution_update': {
      const run = state.toolRuns[event.toolCallId]
      const partialText = event.partialResult?.content
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (run) {
        if (partialText !== undefined) {
          state.toolRuns[event.toolCallId] = { ...run, partialText }
        }
      } else {
        state.toolRuns[event.toolCallId] = {
          toolCallId: event.toolCallId,
          name: event.toolName,
          args: event.args,
          status: 'running',
          ...(partialText !== undefined ? { partialText } : {})
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
      const next: ToolRun = { ...run, status: event.isError ? 'error' : 'done', result: event.result }
      if (run.startedAt !== undefined) {
        next.durationMs = Date.now() - run.startedAt
      }
      delete next.partialText
      state.toolRuns[event.toolCallId] = next
      return false
    }

    case 'bash_execution_update': {
      // Live output of a `!command`: append to the running bash row.
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const message = state.messages[i]!
        if (message.kind === 'bash' && message.running) {
          state.messages[i] = { ...message, output: message.output + event.delta }
          break
        }
      }
      return false
    }

    case 'compaction_start':
      pushNotice(state, 'Compacting context…')
      return false

    case 'compaction_end':
      if (!event.aborted && event.result) {
        state.messages.push({
          kind: 'notice',
          key: nextKey('notice'),
          text: compactedLabel(event.result.tokensBefore, event.result.estimatedTokensAfter),
          tone: 'info',
          ...(event.result.summary ? { detail: event.result.summary } : {})
        })
        return true
      }
      pushNotice(
        state,
        event.aborted
          ? 'Compaction aborted'
          : `Compaction failed${event.errorMessage ? `: ${event.errorMessage}` : ''}`,
        event.aborted ? 'info' : 'error'
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
