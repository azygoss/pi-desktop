import { describe, expect, it } from 'vitest'

import {
  buildChatViewState,
  createChatViewState,
  mapAgentMessage,
  reducePiEvent,
  type ChatViewState
} from './chat-view'
import type { AgentMessage, PiEvent } from './pi-types'

function reduceAll(events: PiEvent[]): ChatViewState {
  const state = createChatViewState()
  for (const e of events) {
    reducePiEvent(state, e)
  }
  return state
}

const streamingTextScript: PiEvent[] = [
  { type: 'agent_start' },
  {
    type: 'message_start',
    message: {
      role: 'assistant',
      content: [],
      api: 'x',
      provider: 'p',
      model: 'm',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'pending',
      timestamp: 1
    }
  },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'think' } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'ing' } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'thinking done' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Hello' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: ' world' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: 'Hello world' } },
  {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'thinking done' },
        { type: 'text', text: 'Hello world' }
      ],
      api: 'x',
      provider: 'p',
      model: 'm',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: 2
    }
  },
  { type: 'agent_end', messages: [] },
  { type: 'agent_settled' }
]

describe('reducePiEvent', () => {
  it('assembles a streamed assistant message from deltas', () => {
    const state = reduceAll(streamingTextScript)
    expect(state.status).toBe('idle')
    expect(state.messages).toHaveLength(1)
    const msg = state.messages[0]
    expect(msg).toMatchObject({ kind: 'assistant' })
    if (msg?.kind === 'assistant') {
      expect(msg.streaming).toBeFalsy()
      expect(msg.blocks).toEqual([
        { type: 'thinking', thinking: 'thinking done' },
        { type: 'text', text: 'Hello world' }
      ])
    }
  })

  it('assembles toolcall args from deltas and finalizes on toolcall_end', () => {
    const state = reduceAll([
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'call_1', toolName: 'bash' } },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"comm' } },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: 'and":"ls"}' } },
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } }
        }
      }
    ])
    const msg = state.messages[0]
    if (msg?.kind === 'assistant') {
      expect(msg.blocks[0]).toEqual({
        type: 'toolCall',
        id: 'call_1',
        name: 'bash',
        arguments: { command: 'ls' }
      })
    }
  })

  it('tracks tool execution lifecycle in toolRuns', () => {
    const state = reduceAll([
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } },
      {
        type: 'tool_execution_update',
        toolCallId: 'c1',
        toolName: 'bash',
        args: {},
        partialResult: { content: [{ type: 'text', text: 'partial' }] }
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'done' }] },
        isError: false
      }
    ])
    expect(state.toolRuns['c1']).toMatchObject({
      name: 'bash',
      status: 'done',
      result: { content: [{ type: 'text', text: 'done' }] }
    })
  })

  it('records how long a live tool run took', () => {
    const state = reduceAll([
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} },
      {
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName: 'bash',
        result: { content: [] },
        isError: false
      }
    ])
    expect(state.toolRuns['c1']!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('marks failed tool runs as error', () => {
    const state = reduceAll([
      { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} },
      {
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName: 'bash',
        result: { content: [] },
        isError: true
      }
    ])
    expect(state.toolRuns['c1']!.status).toBe('error')
  })

  it('adds notices for retry and compaction', () => {
    const state = reduceAll([
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000 },
      { type: 'auto_retry_end', success: false, attempt: 3, finalError: 'overloaded' },
      { type: 'compaction_start', reason: 'threshold' },
      {
        type: 'compaction_end',
        reason: 'threshold',
        result: null,
        aborted: false,
        errorMessage: 'quota'
      }
    ])
    const notices = state.messages.filter((m) => m.kind === 'notice')
    expect(notices).toHaveLength(4)
    expect(notices[1]!.tone).toBe('error')
  })

  it('returns stats-dirty flag on agent_end', () => {
    const state = createChatViewState()
    expect(reducePiEvent(state, { type: 'agent_end', messages: [] })).toBe(true)
    expect(reducePiEvent(state, { type: 'turn_start' })).toBe(false)
  })
})

describe('buildChatViewState', () => {
  it('maps persisted messages and attaches toolResults to runs', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'hi', timestamp: 1 },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'running ls' },
          { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }
        ],
        api: 'x',
        provider: 'p',
        model: 'm',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        timestamp: 2
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'file.txt' }],
        isError: false,
        timestamp: 3
      }
    ]
    const state = buildChatViewState(messages)
    expect(state.messages).toHaveLength(2)
    expect(state.messages[0]).toMatchObject({ kind: 'user', text: 'hi' })
    expect(state.toolRuns['c1']).toMatchObject({ name: 'bash', status: 'done' })
    expect(state.toolRuns['c1']!.result?.content[0]).toMatchObject({ text: 'file.txt' })
    // The result alone has no arguments; they come from the toolCall block.
    expect(state.toolRuns['c1']!.args).toEqual({ command: 'ls' })
  })

  it('extracts text and images from array-form user content', () => {
    const msg = mapAgentMessage({
      role: 'user',
      content: [
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'text', text: 'look at this' }
      ],
      timestamp: 1
    })
    expect(msg).toMatchObject({ kind: 'user', text: 'look at this' })
    if (msg?.kind === 'user') {
      expect(msg.images).toHaveLength(1)
    }
  })
})

describe('message queue', () => {
  it('mirrors queue_update and clears when the run settles', () => {
    const state = createChatViewState()
    reducePiEvent(state, { type: 'agent_start' })
    reducePiEvent(state, { type: 'queue_update', steering: ['a'], followUp: ['b'] })
    expect(state.queue).toEqual({ steering: ['a'], followUp: ['b'] })
    reducePiEvent(state, { type: 'queue_update', steering: [], followUp: [] })
    expect(state.queue).toBeUndefined()
    reducePiEvent(state, { type: 'queue_update', steering: ['a'], followUp: [] })
    reducePiEvent(state, { type: 'agent_settled' })
    expect(state.queue).toBeUndefined()
  })

  it('drops a queued message once pi delivers it', () => {
    const state = createChatViewState()
    state.queue = { steering: ['change direction'], followUp: ['then summarize'] }
    reducePiEvent(state, {
      type: 'message_start',
      message: { role: 'user', content: 'change direction', timestamp: 1 }
    })
    expect(state.queue).toEqual({ steering: [], followUp: ['then summarize'] })
    expect(state.messages.at(-1)).toMatchObject({ kind: 'user', text: 'change direction' })
  })
})

describe('shell runs', () => {
  it('appends streamed output to the running bash row', () => {
    const state = createChatViewState()
    state.messages.push({ kind: 'bash', key: 'b1', command: 'ls', output: '', running: true })
    reducePiEvent(state, { type: 'bash_execution_update', delta: 'one\n' })
    reducePiEvent(state, { type: 'bash_execution_update', delta: 'two\n' })
    expect(state.messages[0]).toMatchObject({ output: 'one\ntwo\n', running: true })
  })

  it("does not duplicate the row when pi reports the command's message", () => {
    const state = createChatViewState()
    state.messages.push({ kind: 'bash', key: 'b1', command: 'ls', output: 'x', running: true })
    const message = {
      role: 'bashExecution' as const,
      command: 'ls',
      output: 'x',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 2
    }
    reducePiEvent(state, { type: 'message_start', message })
    reducePiEvent(state, { type: 'message_end', message })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({ key: 'b1', exitCode: 0 })
  })
})
