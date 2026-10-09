#!/usr/bin/env node
// Synthetic `pi --mode rpc` stand-in used by unit tests and e2e runs.
// Reads JSONL commands from stdin and writes canned JSONL responses/events to
// stdout. Everything here is synthetic.
//
// Env:
//   PI_FAKE_PI_DELAY_MS   delay between streamed chunks during a scripted
//                         prompt reply (default 40)
//   PI_FAKE_PI_MESSAGES   JSON array of canned messages for get_messages
//   PI_DESKTOP_BRIDGE_URL / PI_DESKTOP_BRIDGE_TOKEN — set by the app; when a
//                         prompt mentions "browser" the fixture performs real
//                         bridge calls (like the pi extension would) so e2e
//                         covers the whole browser-tools path.
import { readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

if (process.argv.includes('--version')) {
  process.stdout.write('0.0.0-test\n')
  process.exit(0)
}

// PI_FAKE_PI_DIE=1: the process exits immediately, like a broken pi install —
// the app should surface a "pi could not start" card.
if (process.env['PI_FAKE_PI_DIE'] === '1') {
  process.stderr.write('synthetic pi startup failure\n')
  process.exit(1)
}

const DELAY_MS = Number(process.env['PI_FAKE_PI_DELAY_MS'] ?? 40)

const decoder = new StringDecoder('utf8')
let buffer = ''

/** Context-usage percent override, set by prompts containing `ctxNN`. */
let statsPct = 78.3

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
    thinkingLevelMap: {
      off: 'off',
      minimal: 'min',
      low: 'low',
      medium: 'med',
      high: 'high',
      xhigh: null,
      max: null
    },
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

const ALL_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function levelsFor(model) {
  if (!model.reasoning) {
    return ['off']
  }
  const map = model.thinkingLevelMap
  if (!map) {
    return ALL_LEVELS
  }
  return ALL_LEVELS.filter((l) => map[l] !== null)
}

let currentModel = FAKE_MODELS[0]
let thinkingLevel = 'medium'

const USAGE = {
  input: 100,
  output: 12,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 112,
  cost: { input: 0.0003, output: 0.00018, cacheRead: 0, cacheWrite: 0, total: 0.00048 }
}

let streaming = false
/** Counts completed prompt runs — stats stay zeroed until the first one. */
let promptsRun = 0
/** A "fail once please" prompt fails once, then answers normally. */
let failedOnce = false

const BRIDGE_URL = process.env['PI_DESKTOP_BRIDGE_URL']
const BRIDGE_TOKEN = process.env['PI_DESKTOP_BRIDGE_TOKEN']

async function bridgeCall(tool, params) {
  const res = await fetch(`${BRIDGE_URL}/call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${BRIDGE_TOKEN}`
    },
    body: JSON.stringify({ tool, params: params ?? {} })
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error ?? `bridge HTTP ${res.status}`)
  }
  return body.result
}

/** Emit tool_execution_start → bridge call → tool_execution_end + toolResult. */
async function emitToolRun(callId, toolName, args, call) {
  writeLine({
    type: 'tool_execution_start',
    toolCallId: callId,
    toolName,
    args
  })
  let content
  let isError = false
  let details
  try {
    const result = await call()
    content = [
      ...(result?.image
        ? [{ type: 'image', data: result.image.data, mimeType: result.image.mimeType }]
        : []),
      { type: 'text', text: result?.text ?? 'Done' }
    ]
    details = result?.details
  } catch (error) {
    isError = true
    content = [{ type: 'text', text: error instanceof Error ? error.message : String(error) }]
  }
  writeLine({
    type: 'tool_execution_end',
    toolCallId: callId,
    toolName,
    result: { content, details },
    isError
  })
  const toolResult = {
    role: 'toolResult',
    toolCallId: callId,
    toolName,
    content,
    isError,
    timestamp: Date.now()
  }
  writeLine({ type: 'message_start', message: toolResult })
  writeLine({ type: 'message_end', message: toolResult })
  return toolResult
}

/**
 * Scripted reply that drives the app's real browser tools over the bridge —
 * the same calls the bundled pi extension makes. Used when the prompt
 * mentions "browser" and a URL.
 */
async function scriptedBrowserReply(id, promptMessage) {
  streaming = true
  writeLine({ type: 'agent_start' })
  const userEcho = { role: 'user', content: promptMessage ?? '', timestamp: Date.now() }
  writeLine({ type: 'message_start', message: userEcho })
  writeLine({ type: 'message_end', message: userEcho })
  writeLine({ type: 'turn_start' })

  const url = promptMessage?.match(/https?:\/\/\S+/)?.[0] ?? 'http://127.0.0.1/'
  const toolCalls = [
    { type: 'toolCall', id: 'call_browser_1', name: 'browser_open', arguments: { url } },
    { type: 'toolCall', id: 'call_browser_2', name: 'browser_screenshot', arguments: {} }
  ]
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
  toolCalls.forEach((toolCall, index) => {
    writeLine({
      type: 'message_update',
      usage: USAGE,
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: index,
        id: toolCall.id,
        toolName: toolCall.name
      }
    })
    writeLine({
      type: 'message_update',
      usage: USAGE,
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: index,
        toolCall
      }
    })
  })
  const callMessage = {
    role: 'assistant',
    content: toolCalls,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'synthetic-sonnet',
    usage: USAGE,
    stopReason: 'toolUse',
    timestamp: Date.now()
  }
  writeLine({ type: 'message_end', message: callMessage })

  const toolResults = []
  toolResults.push(
    await emitToolRun('call_browser_1', 'browser_open', { url }, () =>
      bridgeCall('browser_open', { url })
    )
  )
  toolResults.push(
    await emitToolRun('call_browser_2', 'browser_screenshot', {}, () =>
      bridgeCall('browser_screenshot', {})
    )
  )
  writeLine({ type: 'turn_end', message: callMessage, toolResults })

  // final assistant text turn
  writeLine({ type: 'turn_start' })
  const done = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Browser tools ran — see the right panel.' }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'synthetic-sonnet',
    usage: USAGE,
    stopReason: 'stop',
    timestamp: Date.now()
  }
  writeLine({ type: 'message_start', message: { ...done, content: [] } })
  writeLine({ type: 'message_end', message: done })
  writeLine({ type: 'turn_end', message: done, toolResults: [] })
  writeLine({ type: 'agent_end', messages: [done], willRetry: false })
  streaming = false
  writeLine({ type: 'agent_settled' })
}

/**
 * "show image <path>": calls show_image as the pi extension would — the real
 * implementation from resources/pi-extension — then answers in text.
 */
async function scriptedShowImage(promptMessage) {
  streaming = true
  writeLine({ type: 'agent_start' })
  const userEcho = { role: 'user', content: promptMessage ?? '', timestamp: Date.now() }
  writeLine({ type: 'message_start', message: userEcho })
  writeLine({ type: 'message_end', message: userEcho })
  writeLine({ type: 'turn_start' })
  const path = /show image\s+(\S+)/i.exec(String(promptMessage))?.[1] ?? 'image.png'
  const toolCall = {
    type: 'toolCall',
    id: 'call_show_1',
    name: 'show_image',
    arguments: { paths: [path], caption: 'Synthetic image' }
  }
  const callMessage = {
    role: 'assistant',
    content: [toolCall],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'synthetic-sonnet',
    usage: USAGE,
    stopReason: 'toolUse',
    timestamp: Date.now()
  }
  writeLine({ type: 'message_start', message: { ...callMessage, content: [] } })
  writeLine({ type: 'message_end', message: callMessage })
  const { showImage } = await import('../../resources/pi-extension/pi-desktop-browser/show-image.js')
  writeLine({ type: 'tool_execution_start', toolCallId: toolCall.id, toolName: 'show_image', args: toolCall.arguments })
  let content
  let isError = false
  try {
    content = (await showImage(toolCall.arguments, process.cwd())).content
  } catch (error) {
    isError = true
    content = [{ type: 'text', text: error instanceof Error ? error.message : String(error) }]
  }
  writeLine({ type: 'tool_execution_end', toolCallId: toolCall.id, toolName: 'show_image', result: { content }, isError })
  const toolResult = { role: 'toolResult', toolCallId: toolCall.id, toolName: 'show_image', content, isError, timestamp: Date.now() }
  writeLine({ type: 'message_start', message: toolResult })
  writeLine({ type: 'message_end', message: toolResult })
  writeLine({ type: 'turn_end', message: callMessage, toolResults: [toolResult] })
  writeLine({ type: 'turn_start' })
  const done = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Here it is.' }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'synthetic-sonnet',
    usage: USAGE,
    stopReason: 'stop',
    timestamp: Date.now()
  }
  writeLine({ type: 'message_start', message: { ...done, content: [] } })
  writeLine({ type: 'message_end', message: done })
  writeLine({ type: 'turn_end', message: done, toolResults: [] })
  writeLine({ type: 'agent_end', messages: [done], willRetry: false })
  streaming = false
  writeLine({ type: 'agent_settled' })
}

const SCRIPT_TEXT =
  'Here is a synthetic reply with a code block.\n\n' +
  '```ts\n' +
  'export function greet(name: string): string {\n' +
  '  return `Hello, ${name}!`\n' +
  '}\n' +
  '```\n\n' +
  'And a quick `ls` below.\n\n' +
  '| Step | Status |\n' +
  '| --- | --- |\n' +
  '| Scan project | Done |\n' +
  '| Patch router | Pending |\n\n' +
  '> Synthetic blockquote for styling checks.\n\n' +
  '- first item\n' +
  '  - nested item\n' +
  '- second item\n\n' +
  '1. ordered one\n' +
  '2. ordered two\n\n' +
  '- [ ] pending task\n' +
  '- [x] done task\n\n' +
  'See the [pi docs](https://pi.dev/docs/latest) for details.'

/**
 * Scripted assistant reply. `preDelayMs` pauses between the empty
 * message_start and the first delta so e2e can capture the
 * "Thinking · Ns" pending state.
 */
async function scriptedReply(id, promptMessage, preDelayMs = 0) {
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

  if (preDelayMs > 0) {
    await sleep(preDelayMs)
  }

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
    assistantMessageEvent: {
      type: 'thinking_end',
      contentIndex: 0,
      content: 'Let me think about this briefly.'
    }
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
    assistantMessageEvent: {
      type: 'toolcall_start',
      contentIndex: 2,
      id: 'call_demo_1',
      toolName: 'bash'
    }
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
      toolCall: {
        type: 'toolCall',
        id: 'call_demo_1',
        name: 'bash',
        arguments: { command: 'ls -la' }
      }
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

/**
 * Scripted "needs input" turn: echoes the user message, then emits an
 * extension_ui_request and leaves the turn open until the response arrives.
 */
function scriptedAskReply(promptMessage) {
  streaming = true
  writeLine({ type: 'agent_start' })
  const userEcho = { role: 'user', content: promptMessage ?? '', timestamp: Date.now() }
  writeLine({ type: 'message_start', message: userEcho })
  writeLine({ type: 'message_end', message: userEcho })
  writeLine({
    type: 'extension_ui_request',
    id: 'ui-ask-1',
    method: 'confirm',
    title: 'Proceed with the change?'
  })
}

/** Close the turn left open by scriptedAskReply once the user answers. */
function settleAskedTurn() {
  const finalMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Proceeding as confirmed.' }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'synthetic-sonnet',
    usage: USAGE,
    stopReason: 'stop',
    timestamp: Date.now()
  }
  writeLine({ type: 'message_start', message: { ...finalMessage, content: [] } })
  writeLine({ type: 'message_end', message: finalMessage })
  writeLine({ type: 'turn_end', message: finalMessage, toolResults: [] })
  writeLine({ type: 'agent_end', messages: [finalMessage], willRetry: false })
  streaming = false
  writeLine({ type: 'agent_settled' })
}

/**
 * Scripted reply that runs three consecutive tool calls — an edit, a write and
 * a failing bash — so e2e can cover grouped tool summaries, diff stats and the
 * failed-tool counter.
 */
/** A plain text reply with no thinking or tools. */
async function scriptedTextReply(text) {
  streaming = true
  writeLine({ type: 'agent_start' })
  writeLine({ type: 'turn_start' })
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'synthetic-sonnet',
    usage: USAGE,
    stopReason: 'stop',
    timestamp: Date.now()
  }
  writeLine({ type: 'message_start', message: { ...message, content: [] } })
  await sleep(DELAY_MS)
  writeLine({
    type: 'message_update',
    usage: USAGE,
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text }
  })
  writeLine({ type: 'message_end', message })
  writeLine({ type: 'turn_end', message, toolResults: [] })
  streaming = false
  writeLine({ type: 'agent_end', messages: [message], willRetry: false })
  writeLine({ type: 'agent_settled' })
}

async function scriptedGroupReply(promptMessage) {
  streaming = true
  writeLine({ type: 'agent_start' })
  const userEcho = { role: 'user', content: promptMessage ?? '', timestamp: Date.now() }
  writeLine({ type: 'message_start', message: userEcho })
  writeLine({ type: 'message_end', message: userEcho })

  writeLine({ type: 'turn_start' })
  const toolCalls = [
    {
      type: 'toolCall',
      id: 'call_edit_1',
      name: 'edit',
      arguments: {
        path: 'src/synthetic.ts',
        oldText: 'const a = 1\nconst b = 2',
        newText: 'const a = 1\nconst b = 3\nconst c = 4'
      }
    },
    {
      type: 'toolCall',
      id: 'call_write_1',
      name: 'write',
      arguments: {
        path: 'src/synthetic-new.ts',
        content: 'line one\nline two\nline three'
      }
    },
    {
      type: 'toolCall',
      id: 'call_bash_1',
      name: 'bash',
      arguments: { command: 'false' }
    }
  ]
  const callMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Applying the synthetic edits.' }, ...toolCalls],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'synthetic-sonnet',
    usage: USAGE,
    stopReason: 'toolUse',
    timestamp: Date.now()
  }
  writeLine({ type: 'message_start', message: { ...callMessage, content: [] } })
  writeLine({ type: 'message_end', message: callMessage })

  const toolResults = []
  for (const toolCall of toolCalls) {
    writeLine({
      type: 'tool_execution_start',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments
    })
    await sleep(DELAY_MS)
    const isError = toolCall.name === 'bash'
    const content = [
      {
        type: 'text',
        text: isError ? 'command failed with exit code 1' : `ok: ${toolCall.name}`
      }
    ]
    writeLine({
      type: 'tool_execution_end',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: { content },
      isError
    })
    const toolResult = {
      role: 'toolResult',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content,
      isError,
      timestamp: Date.now()
    }
    writeLine({ type: 'message_start', message: toolResult })
    writeLine({ type: 'message_end', message: toolResult })
    toolResults.push(toolResult)
  }
  writeLine({ type: 'turn_end', message: callMessage, toolResults })

  writeLine({ type: 'turn_start' })
  const finalMessage = {
    ...callMessage,
    content: [{ type: 'text', text: 'Edits applied; the last command failed as scripted.' }],
    stopReason: 'stop',
    timestamp: Date.now()
  }
  writeLine({ type: 'message_start', message: { ...finalMessage, content: [] } })
  writeLine({ type: 'message_end', message: finalMessage })
  writeLine({ type: 'turn_end', message: finalMessage, toolResults: [] })
  writeLine({ type: 'agent_end', messages: [finalMessage], willRetry: false })
  streaming = false
  writeLine({ type: 'agent_settled' })
}

/**
 * Energy benchmark: one bash tool call that runs for N seconds ("long tool
 * for 8s") — the agent is working but nothing streams, which is where live
 * indicators (dots, timers) dominate the app's energy use.
 */
async function scriptedLongTool(promptMessage) {
  streaming = true
  writeLine({ type: 'agent_start' })
  const userEcho = { role: 'user', content: promptMessage ?? '', timestamp: Date.now() }
  writeLine({ type: 'message_start', message: userEcho })
  writeLine({ type: 'message_end', message: userEcho })
  writeLine({ type: 'turn_start' })
  const seconds = Number(/\bfor (\d+)s\b/.exec(String(promptMessage))?.[1] ?? 10)
  const toolCall = {
    type: 'toolCall',
    id: 'call_long_1',
    name: 'bash',
    arguments: { command: 'sleep 10 && echo done' }
  }
  const callMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Running the long command.' }, toolCall],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'synthetic-sonnet',
    usage: USAGE,
    stopReason: 'toolUse',
    timestamp: Date.now()
  }
  writeLine({ type: 'message_start', message: { ...callMessage, content: [] } })
  writeLine({ type: 'message_end', message: callMessage })
  writeLine({
    type: 'tool_execution_start',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments
  })
  await sleep(seconds * 1000)
  const content = [{ type: 'text', text: 'done' }]
  writeLine({
    type: 'tool_execution_end',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result: { content },
    isError: false
  })
  const toolResult = {
    role: 'toolResult',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content,
    isError: false,
    timestamp: Date.now()
  }
  writeLine({ type: 'message_start', message: toolResult })
  writeLine({ type: 'message_end', message: toolResult })
  writeLine({ type: 'turn_end', message: callMessage, toolResults: [toolResult] })
  const finalMessage = {
    ...callMessage,
    content: [{ type: 'text', text: 'The command finished.' }],
    stopReason: 'stop',
    timestamp: Date.now()
  }
  writeLine({ type: 'turn_start' })
  writeLine({ type: 'message_start', message: { ...finalMessage, content: [] } })
  writeLine({ type: 'message_end', message: finalMessage })
  writeLine({ type: 'turn_end', message: finalMessage, toolResults: [] })
  writeLine({ type: 'agent_end', messages: [finalMessage], willRetry: false })
  streaming = false
  writeLine({ type: 'agent_settled' })
}

/**
 * Energy benchmark reply: model-paced deltas (~60/s) over several seconds —
 * a thinking phase, then markdown prose with a fenced code block — so
 * scripts/energy.mjs can measure CPU while a realistic reply streams.
 */
async function scriptedPacedStream(promptMessage) {
  streaming = true
  writeLine({ type: 'agent_start' })
  const userEcho = { role: 'user', content: promptMessage ?? '', timestamp: Date.now() }
  writeLine({ type: 'message_start', message: userEcho })
  writeLine({ type: 'message_end', message: userEcho })
  writeLine({ type: 'turn_start' })
  const base = {
    role: 'assistant',
    content: [],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'synthetic-sonnet',
    usage: USAGE,
    stopReason: 'pending',
    timestamp: Date.now()
  }
  writeLine({ type: 'message_start', message: base })
  const seconds = Number(/\bfor (\d+)s\b/.exec(String(promptMessage))?.[1] ?? 10)
  const thinkingMs = Math.min(3000, seconds * 250)
  const emit = async (kind, index, text, durationMs) => {
    writeLine({
      type: 'message_update',
      usage: USAGE,
      assistantMessageEvent: { type: `${kind}_start`, contentIndex: index }
    })
    const chunks = text.match(/.{1,4}/gs) ?? []
    const gap = Math.max(1, durationMs / chunks.length)
    for (const delta of chunks) {
      await sleep(gap)
      if (!streaming) return
      writeLine({
        type: 'message_update',
        usage: USAGE,
        assistantMessageEvent: { type: `${kind}_delta`, contentIndex: index, delta }
      })
    }
    writeLine({
      type: 'message_update',
      usage: USAGE,
      assistantMessageEvent: { type: `${kind}_end`, contentIndex: index, content: text }
    })
  }
  const thinking = 'Weighing the options for the synthetic task step by step. '.repeat(6)
  const para =
    'The **synthetic** reply walks through a change with `inline code`, a list and a block.\n\n' +
    '- first point about the approach\n- second point with a [link](https://example.com)\n\n' +
    '```ts\nexport function add(a: number, b: number): number {\n  return a + b\n}\n```\n\n'
  const text = para.repeat(Math.max(1, Math.round(seconds / 2)))
  await emit('thinking', 0, thinking, thinkingMs)
  await emit('text', 1, text, seconds * 1000 - thinkingMs)
  const finalMessage = {
    ...base,
    content: [
      { type: 'thinking', thinking },
      { type: 'text', text }
    ],
    stopReason: 'stop',
    timestamp: Date.now()
  }
  writeLine({ type: 'message_end', message: finalMessage })
  writeLine({ type: 'turn_end', message: finalMessage, toolResults: [] })
  writeLine({ type: 'agent_end', messages: [finalMessage], willRetry: false })
  streaming = false
  writeLine({ type: 'agent_settled' })
}

/**
 * Perf benchmark reply: ~2000 small text deltas written as fast as stdout
 * drains, then a normal end sequence. Used by scripts/perf.mjs to measure
 * main→renderer IPC throughput.
 */
async function scriptedFastStream(promptMessage) {
  streaming = true
  writeLine({ type: 'agent_start' })
  const userEcho = { role: 'user', content: promptMessage ?? '', timestamp: Date.now() }
  writeLine({ type: 'message_start', message: userEcho })
  writeLine({ type: 'message_end', message: userEcho })
  writeLine({ type: 'turn_start' })
  const base = {
    role: 'assistant',
    content: [],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'synthetic-sonnet',
    usage: USAGE,
    stopReason: 'pending',
    timestamp: Date.now()
  }
  writeLine({ type: 'message_start', message: base })
  writeLine({
    type: 'message_update',
    usage: USAGE,
    assistantMessageEvent: { type: 'text_start', contentIndex: 0 }
  })
  let text = ''
  for (let i = 0; i < 2000; i++) {
    const delta = `w${i % 10} `
    text += delta
    writeLine({
      type: 'message_update',
      usage: USAGE,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta }
    })
    if (i % 200 === 0) {
      await sleep(0) // let stdout flush
    }
  }
  writeLine({
    type: 'message_update',
    usage: USAGE,
    assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: text }
  })
  const finalMessage = {
    ...base,
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    timestamp: Date.now()
  }
  writeLine({ type: 'message_end', message: finalMessage })
  writeLine({ type: 'turn_end', message: finalMessage, toolResults: [] })
  writeLine({ type: 'agent_end', messages: [finalMessage], willRetry: false })
  streaming = false
  writeLine({ type: 'agent_settled' })
}

/** Session loaded through switch_session (warm-spare adoption). */
let switchedSession = null

function getMessages() {
  const raw = process.env['PI_FAKE_PI_MESSAGES']
  if (raw) {
    try {
      return JSON.parse(raw)
    } catch {
      return []
    }
  }
  // Spawned with `--session <file>` (or switched via switch_session): serve
  // that session's messages like real pi does, so transcript restores and
  // post-fork refreshes see history.
  const sessionIdx = process.argv.indexOf('--session')
  const sessionFile = switchedSession ?? (sessionIdx !== -1 ? process.argv[sessionIdx + 1] : null)
  if (sessionFile) {
    try {
      return readFileSync(sessionFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === 'message')
        .map((e) => e.message)
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
          model: currentModel,
          thinkingLevel,
          isStreaming: streaming,
          isCompacting: false,
          steeringMode: 'one-at-a-time',
          followUpMode: 'one-at-a-time',
          sessionFile: switchedSession,
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
        // PI_FAKE_NO_MODELS=1: a fresh pi with no provider configured.
        data: { models: process.env['PI_FAKE_NO_MODELS'] === '1' ? [] : FAKE_MODELS }
      })
      break
    case 'get_available_thinking_levels':
      writeLine({
        id,
        type: 'response',
        command: 'get_available_thinking_levels',
        success: true,
        data: { levels: levelsFor(currentModel) }
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
        data: (() => {
          // A session with no turns yet reports zeros, like real pi.
          const hasTurns = promptsRun > 0 || getMessages().length > 0
          const pct = hasTurns ? statsPct : 0
          return {
            sessionFile: null,
            sessionId: 'fake-session',
            userMessages: hasTurns ? 2 : 0,
            assistantMessages: hasTurns ? 2 : 0,
            toolCalls: hasTurns ? 1 : 0,
            toolResults: hasTurns ? 1 : 0,
            totalMessages: hasTurns ? 5 : 0,
            tokens: hasTurns
              ? {
                  input: 120000,
                  output: 32000,
                  cacheRead: 4000,
                  cacheWrite: 600,
                  total: 156600
                }
              : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: hasTurns ? 0.42 : 0,
            contextUsage: {
              tokens: Math.round(200000 * (pct / 100)),
              contextWindow: 200000,
              percent: pct
            }
          }
        })()
      })
      break
    case 'set_model': {
      const next =
        FAKE_MODELS.find((m) => m.provider === command.provider && m.id === command.modelId) ??
        currentModel
      currentModel = next
      // Clamp the level like the real agent does for a model with fewer levels.
      const levels = levelsFor(next)
      if (!levels.includes(thinkingLevel)) {
        thinkingLevel = levels[levels.length - 1]
      }
      writeLine({ id, type: 'response', command: 'set_model', success: true, data: next })
      break
    }
    case 'set_thinking_level':
      if (levelsFor(currentModel).includes(command.level)) {
        thinkingLevel = command.level
      }
      writeLine({ id, type: 'response', command: 'set_thinking_level', success: true })
      break
    case 'prompt':
    case 'steer':
    case 'follow_up': {
      // A prompt-level failure exercises the sidebar error dot.
      if (/\bfail please\b/i.test(String(command.message))) {
        writeLine({
          id,
          type: 'response',
          command: command.type,
          success: false,
          error: 'synthetic failure'
        })
        break
      }
      // Fails the first matching prompt, then answers normally — covers the
      // error row's Retry resending the same prompt.
      if (/\bfail once please\b/i.test(String(command.message)) && !failedOnce) {
        failedOnce = true
        writeLine({
          id,
          type: 'response',
          command: command.type,
          success: false,
          error: 'synthetic failure'
        })
        break
      }
      writeLine({ id, type: 'response', command: command.type, success: true })
      promptsRun += 1
      const ctxMatch = /\bctx(\d+)\b/i.exec(String(command.message))
      if (ctxMatch) {
        statsPct = Number(ctxMatch[1])
      }
      if (/Output only a JSON array/.test(String(command.message))) {
        // The diff panel's review pass: a machine-readable list of remarks.
        void scriptedTextReply(
          `\`\`\`json\n[{"path":"notes.txt","line":1,"comment":"Synthetic review remark by ${currentModel.id}."}]\n\`\`\``
        )
      } else if (/\bside question\b/i.test(String(command.message))) {
        void scriptedTextReply('Synthetic side answer.')
      } else if (/\bask me\b/i.test(String(command.message))) {
        void scriptedAskReply(command.message)
      } else if (/long tool/i.test(String(command.message))) {
        void scriptedLongTool(command.message)
      } else if (/paced stream/i.test(String(command.message))) {
        void scriptedPacedStream(command.message)
      } else if (/stream perf/i.test(String(command.message))) {
        void scriptedFastStream(command.message)
      } else if (/\bslow\b/i.test(String(command.message))) {
        // Long pause before the first delta so tests can capture the
        // pre-token "Thinking · Ns" state.
        void scriptedReply(id, command.message, 2500)
      } else if (/\bgroup tools\b/i.test(String(command.message))) {
        void scriptedGroupReply(command.message)
      } else if (/\bshow image\b/i.test(String(command.message))) {
        void scriptedShowImage(command.message)
      } else if (BRIDGE_URL && BRIDGE_TOKEN && /\bbrowser\b/i.test(String(command.message))) {
        void scriptedBrowserReply(id, command.message)
      } else {
        void scriptedReply(id, command.message)
      }
      break
    }
    case 'bash': {
      // `!command` from the composer: stream two chunks, then the result.
      const text = String(command.command)
      const failing = /\bfalse\b/.test(text)
      void (async () => {
        writeLine({ type: 'bash_execution_update', id, delta: `synthetic output of ${text}\n` })
        await sleep(DELAY_MS)
        writeLine({ type: 'bash_execution_update', id, delta: 'second line\n' })
        await sleep(DELAY_MS)
        writeLine({
          id,
          type: 'response',
          command: 'bash',
          success: true,
          data: {
            output: `synthetic output of ${text}\nsecond line\n`,
            exitCode: failing ? 1 : 0,
            cancelled: false,
            truncated: false
          }
        })
      })()
      break
    }
    case 'clear_queue':
      writeLine({ type: 'queue_update', steering: [], followUp: [] })
      writeLine({
        id,
        type: 'response',
        command: 'clear_queue',
        success: true,
        data: { steering: [], followUp: [] }
      })
      break
    case 'abort':
      streaming = false
      writeLine({ type: 'agent_end', messages: [], willRetry: false })
      writeLine({ type: 'agent_settled' })
      writeLine({ id, type: 'response', command: 'abort', success: true })
      break
    case 'switch_session':
      // PI_FAKE_PI_SWITCH_CANCEL mimics an extension vetoing the switch.
      if (process.env['PI_FAKE_PI_SWITCH_CANCEL'] !== '1') {
        switchedSession = String(command.sessionPath)
      }
      writeLine({
        id,
        type: 'response',
        command: 'switch_session',
        success: true,
        data: { cancelled: process.env['PI_FAKE_PI_SWITCH_CANCEL'] === '1' }
      })
      break
    case 'new_session':
      writeLine({
        id,
        type: 'response',
        command: 'new_session',
        success: true,
        data: { cancelled: false }
      })
      break
    case 'set_session_name':
      writeLine({ id, type: 'response', command: 'set_session_name', success: true })
      break
    case 'compact':
      writeLine({ id, type: 'response', command: 'compact', success: true })
      break
    case 'export_html':
      writeLine({
        id,
        type: 'response',
        command: 'export_html',
        success: true,
        data: { path: command.outputPath ?? null }
      })
      break
    case 'get_fork_messages':
      writeLine({
        id,
        type: 'response',
        command: 'get_fork_messages',
        success: true,
        data: {
          messages: getMessages()
            .filter((m) => m.role === 'user')
            .map((m, i) => ({
              entryId: `entry-${i}`,
              text: typeof m.content === 'string' ? m.content : '(synthetic user message)'
            }))
        }
      })
      break
    case 'fork':
      writeLine({
        id,
        type: 'response',
        command: 'fork',
        success: true,
        data: { text: '(forked message text)', cancelled: false }
      })
      break
    case 'clone':
      writeLine({
        id,
        type: 'response',
        command: 'clone',
        success: true,
        data: { cancelled: false }
      })
      break
    // --- generic test commands -------------------------------------------------
    case 'echo':
      writeLine({ id, type: 'response', command: 'echo', success: true, data: command.data })
      break
    case 'fail':
      writeLine({
        id,
        type: 'response',
        command: 'fail',
        success: false,
        error: 'synthetic failure'
      })
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
      if (streaming) {
        settleAskedTurn()
      }
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
