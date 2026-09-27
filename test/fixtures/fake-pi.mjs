#!/usr/bin/env node
// Synthetic `pi --mode rpc` stand-in used by unit tests and e2e runs.
// Reads JSONL commands from stdin and writes canned JSONL responses/events to
// stdout. Everything here is synthetic.
//
// Env:
//   PI_FAKE_PI_DELAY_MS   delay between streamed chunks during a scripted
//                         prompt reply (default 40)
//   PI_FAKE_PI_MESSAGES   JSON array of canned messages for get_messages
import { StringDecoder } from 'node:string_decoder'

if (process.argv.includes('--version')) {
  process.stdout.write('0.0.0-test\n')
  process.exit(0)
}

const DELAY_MS = Number(process.env['PI_FAKE_PI_DELAY_MS'] ?? 40)

const decoder = new StringDecoder('utf8')
let buffer = ''

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const FAKE_MODELS = [
  {
    id: 'synthetic-sonnet',
    name: 'Synthetic Sonnet',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://example.invalid',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
  },
  {
    id: 'synthetic-haiku',
    name: 'Synthetic Haiku',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 }
  },
  {
    id: 'synthetic-gpt',
    name: 'Synthetic GPT',
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'https://example.invalid',
    reasoning: true,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }
  },
  {
    id: 'synthetic-local',
    name: 'Synthetic Local',
    api: 'local',
    provider: 'local',
    baseUrl: 'http://localhost:1234',
    reasoning: false,
    input: ['text'],
    contextWindow: 8192,
    maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
]

const USAGE = {
  input: 100,
  output: 12,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 112,
  cost: { input: 0.0003, output: 0.00018, cacheRead: 0, cacheWrite: 0, total: 0.00048 }
}

let streaming = false

const SCRIPT_TEXT =
  'Here is a synthetic reply with a code block.\n\n' +
  '```ts\n' +
  'export function greet(name: string): string {\n' +
  "  return `Hello, ${name}!`\n" +
  '}\n' +
  '```\n\n' +
  'And a quick `ls` below.'

async function scriptedReply(id, promptMessage) {
  streaming = true
  writeLine({ type: 'agent_start' })
  // Echo of the user message, like the real agent.
  const userEcho = { role: 'user', content: promptMessage ?? '', timestamp: Date.now() }
  writeLine({ type: 'message_start', message: userEcho })
  writeLine({ type: 'message_end', message: userEcho })

  writeLine({ type: 'turn_start' })
  writeLine({
    type: 'message_start',
    message: {
      role: 'assistant',
      content: [],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'synthetic-sonnet',
      usage: USAGE,
      stopReason: 'pending',
      timestamp: Date.now()
    }
  })

  // thinking deltas
  writeLine({
    type: 'message_update',
    usage: USAGE,
    assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 }
  })
  for (const delta of ['Let me ', 'think about ', 'this briefly.']) {
    await sleep(DELAY_MS)
    writeLine({
      type: 'message_update',
      usage: USAGE,
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta }
    })
  }
  writeLine({
    type: 'message_update',
    usage: USAGE,
    assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Let me think about this briefly.' }
  })

  // text deltas
  writeLine({
    type: 'message_update',
    usage: USAGE,
    assistantMessageEvent: { type: 'text_start', contentIndex: 1 }
  })
  for (const delta of SCRIPT_TEXT.match(/.{1,18}/gs) ?? []) {
    await sleep(DELAY_MS)
    writeLine({
      type: 'message_update',
      usage: USAGE,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta }
    })
  }
  writeLine({
    type: 'message_update',
    usage: USAGE,
    assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: SCRIPT_TEXT }
  })

  // tool call: bash ls -la
  writeLine({
    type: 'message_update',
    usage: USAGE,
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 2, id: 'call_demo_1', toolName: 'bash' }
  })
  for (const delta of ['{"command":"ls ', '-la"}']) {
    await sleep(DELAY_MS)
    writeLine({
      type: 'message_update',
      usage: USAGE,
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 2, delta }
    })
  }
  writeLine({
    type: 'message_update',
    usage: USAGE,
    assistantMessageEvent: {
      type: 'toolcall_end',
      contentIndex: 2,
      toolCall: { type: 'toolCall', id: 'call_demo_1', name: 'bash', arguments: { command: 'ls -la' } }
    }
  })
  const assistantMessage = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Let me think about this briefly.' },
      { type: 'text', text: SCRIPT_TEXT },
      { type: 'toolCall', id: 'call_demo_1', name: 'bash', arguments: { command: 'ls -la' } }
    ],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'synthetic-sonnet',
    usage: USAGE,
    stopReason: 'toolUse',
    timestamp: Date.now()
  }
  writeLine({ type: 'message_end', message: assistantMessage })

  // tool execution
  writeLine({
    type: 'tool_execution_start',
    toolCallId: 'call_demo_1',
    toolName: 'bash',
    args: { command: 'ls -la' }
  })
  await sleep(DELAY_MS)
  writeLine({
    type: 'tool_execution_update',
    toolCallId: 'call_demo_1',
    toolName: 'bash',
    args: { command: 'ls -la' },
    partialResult: { content: [{ type: 'text', text: 'total 8\n' }] }
  })
  await sleep(DELAY_MS * 2)
  const toolResult = {
    role: 'toolResult',
    toolCallId: 'call_demo_1',
    toolName: 'bash',
    content: [
      {
        type: 'text',
        text: 'total 8\ndrwxr-xr-x  3 user  staff   96 Jan  1  2025 .\ndrwxr-xr-x  9 user  staff  288 Jan  1  2025 ..\n-rw-r--r--  1 user  staff   42 Jan  1  2025 file.txt\n'
      }
    ],
    isError: false,
    timestamp: Date.now()
  }
  writeLine({
    type: 'tool_execution_end',
    toolCallId: 'call_demo_1',
    toolName: 'bash',
    result: { content: toolResult.content },
    isError: false
  })
  writeLine({ type: 'message_start', message: toolResult })
  writeLine({ type: 'message_end', message: toolResult })
  writeLine({
    type: 'turn_end',
    message: assistantMessage,
    toolResults: [toolResult]
  })

  // final assistant text turn
  writeLine({ type: 'turn_start' })
  writeLine({
    type: 'message_start',
    message: { ...assistantMessage, content: [], timestamp: Date.now() }
  })
  for (const delta of ['Done — `file', '.txt` is 42', ' bytes.']) {
    await sleep(DELAY_MS)
    writeLine({
      type: 'message_update',
      usage: USAGE,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta }
    })
  }
  const finalMessage = {
    ...assistantMessage,
    content: [{ type: 'text', text: 'Done — `file.txt` is 42 bytes.' }],
    stopReason: 'stop',
    timestamp: Date.now()
  }
  writeLine({ type: 'message_end', message: finalMessage })
  writeLine({ type: 'turn_end', message: finalMessage, toolResults: [] })

  writeLine({ type: 'agent_end', messages: [finalMessage], willRetry: false })
  streaming = false
  writeLine({ type: 'agent_settled' })
}

function getMessages() {
  const raw = process.env['PI_FAKE_PI_MESSAGES']
  if (raw) {
    try {
      return JSON.parse(raw)
    } catch {
      return []
    }
  }
  return []
}

function handle(command) {
  const id = command.id
  switch (command.type) {
    case 'get_state':
      writeLine({
        id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          model: FAKE_MODELS[0],
          thinkingLevel: 'medium',
          isStreaming: streaming,
          isCompacting: false,
          steeringMode: 'one-at-a-time',
          followUpMode: 'one-at-a-time',
          sessionFile: null,
          sessionId: 'fake-session',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0
        }
      })
      break
    case 'get_messages':
      writeLine({
        id,
        type: 'response',
        command: 'get_messages',
        success: true,
        data: { messages: getMessages() }
      })
      break
    case 'get_available_models':
      writeLine({
        id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: FAKE_MODELS }
      })
      break
    case 'get_available_thinking_levels':
      writeLine({
        id,
        type: 'response',
        command: 'get_available_thinking_levels',
        success: true,
        data: { levels: ['off', 'minimal', 'low', 'medium', 'high'] }
      })
      break
    case 'get_commands':
      writeLine({
        id,
        type: 'response',
        command: 'get_commands',
        success: true,
        data: {
          commands: [
            { name: 'review-code', description: 'Review staged changes', source: 'prompt' },
            { name: 'skill:synthetic', description: 'Synthetic skill', source: 'skill' }
          ]
        }
      })
      break
    case 'get_session_stats':
      writeLine({
        id,
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: {
          sessionFile: null,
          sessionId: 'fake-session',
          userMessages: 2,
          assistantMessages: 2,
          toolCalls: 1,
          toolResults: 1,
          totalMessages: 5,
          tokens: { input: 1024, output: 256, cacheRead: 0, cacheWrite: 0, total: 1280 },
          cost: 0.0042,
          contextUsage: { tokens: 1280, contextWindow: 200000, percent: 0.64 }
        }
      })
      break
    case 'set_model':
      writeLine({ id, type: 'response', command: 'set_model', success: true, data: FAKE_MODELS[1] })
      break
    case 'set_thinking_level':
      writeLine({ id, type: 'response', command: 'set_thinking_level', success: true })
      break
    case 'prompt':
    case 'steer':
    case 'follow_up':
      writeLine({ id, type: 'response', command: command.type, success: true })
      void scriptedReply(id, command.message)
      break
    case 'abort':
      streaming = false
      writeLine({ type: 'agent_end', messages: [], willRetry: false })
      writeLine({ type: 'agent_settled' })
      writeLine({ id, type: 'response', command: 'abort', success: true })
      break
    case 'new_session':
      writeLine({ id, type: 'response', command: 'new_session', success: true, data: { cancelled: false } })
      break
    // --- generic test commands -------------------------------------------------
    case 'echo':
      writeLine({ id, type: 'response', command: 'echo', success: true, data: command.data })
      break
    case 'fail':
      writeLine({ id, type: 'response', command: 'fail', success: false, error: 'synthetic failure' })
      break
    case 'hang':
      break
    case 'die':
      process.exit(1)
      break
    case 'emit':
      writeLine({ type: 'agent_start' })
      writeLine({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi' }
      })
      writeLine({ id, type: 'response', command: 'emit', success: true })
      break
    case 'ui':
      writeLine({
        type: 'extension_ui_request',
        id: 'ui-1',
        method: 'confirm',
        title: 'Proceed?'
      })
      writeLine({ id, type: 'response', command: 'ui', success: true })
      break
    case 'malformed':
      process.stdout.write('this is not json {{{\n')
      writeLine({ id, type: 'response', command: 'malformed', success: true })
      break
    case 'extension_ui_response':
      writeLine({ type: 'ui_response_seen', response: command })
      break
    default:
      writeLine({ id, type: 'response', command: command.type, success: true, data: null })
  }
}

process.stdin.on('data', (chunk) => {
  buffer += decoder.write(chunk)
  for (;;) {
    const idx = buffer.indexOf('\n')
    if (idx === -1) break
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (line.length === 0) continue
    try {
      handle(JSON.parse(line))
    } catch {
      writeLine({
        type: 'response',
        command: 'parse',
        success: false,
        error: 'Failed to parse command'
      })
    }
  }
})
