// Node-environment test for the chat store: window.piDesktop and
// requestAnimationFrame are stubbed; only the store update paths run.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Model } from '../../../shared/pi-types'

const MODEL_A: Model = {
  id: 'a',
  name: 'Model A',
  api: 'test',
  provider: 'p1',
  baseUrl: 'https://example.invalid',
  reasoning: true,
  input: ['text'],
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

const MODEL_B: Model = { ...MODEL_A, id: 'b', name: 'Model B', provider: 'p2' }

let setModelResult: {
  model: Model | null
  thinkingLevel: string | null
  thinkingLevels: string[]
} | null = null

let eventHandler: ((payload: { chatId: string; events: unknown[] }) => void) | null =
  null

let setCwdCalls: string[] = []
let setCwdHandler:
  | ((input: { chatId: string; cwd: string }) => Promise<unknown>)
  | null = null
let openHandler:
  | ((input: { chatId: string }) => Promise<unknown>)
  | null = null

const fakeApi = {
  chat: {
    onEvent: (cb: (payload: { chatId: string; events: unknown[] }) => void) => {
      eventHandler = cb
      return () => {}
    },
    onReady: () => () => {},
    onUiRequest: () => () => {},
    onExit: () => () => {},
    onStartupHint: () => () => {},
    open: async (input: { chatId: string }) =>
      openHandler
        ? await openHandler(input)
        : {
            chatId: input.chatId,
            cwd: '/tmp/synthetic',
            state: { model: MODEL_A, thinkingLevel: 'high', isStreaming: false },
            messages: [],
            models: [MODEL_A, MODEL_B],
            thinkingLevels: ['off', 'low', 'medium', 'high'],
            commands: []
          },
    setModel: async () => setModelResult,
    setCwd: async (input: { chatId: string; cwd: string }) => {
      setCwdCalls.push(input.cwd)
      return setCwdHandler
        ? await setCwdHandler(input)
        : {
            chatId: input.chatId,
            cwd: input.cwd,
            state: { model: MODEL_A, thinkingLevel: 'high', isStreaming: false },
            messages: [],
            models: [MODEL_A],
            thinkingLevels: ['off', 'high'],
            commands: []
          }
    },
    readTranscript: async () => ({ messages: [], hasEarlier: false, totalMessages: 0 }),
    focus: async () => {}
  },
  catalog: {
    get: async () => ({
      models: [],
      commands: [],
      thinkingLevels: [],
      model: null,
      thinkingLevel: null
    })
  }
}

beforeAll(() => {
  const g = globalThis as unknown as {
    window: { piDesktop: unknown }
    requestAnimationFrame: (cb: FrameRequestCallback) => number
  }
  g.window = { piDesktop: fakeApi }
  g.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0) as unknown as number
})

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5))
}

describe('chat-store model switching', () => {
  let useChatStore: typeof import('./chat-store').useChatStore
  let seq = 0
  let chatId = ''

  beforeEach(async () => {
    setModelResult = null
    const mod = await import('./chat-store')
    useChatStore = mod.useChatStore
    chatId = `c${++seq}` // drafts persist between tests; use a fresh chat
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await flush()
  })

  it('applies pi-reported model, clamped level and new level list', async () => {
    setModelResult = {
      model: MODEL_B,
      thinkingLevel: 'low',
      thinkingLevels: ['off', 'low']
    }
    await useChatStore.getState().setModel(chatId, 'p2', 'b')
    await flush()
    const chat = useChatStore.getState().chats[chatId]!
    expect(chat.model?.id).toBe('b')
    expect(chat.thinkingLevel).toBe('low')
    expect(chat.availableThinkingLevels).toEqual(['off', 'low'])
  })

  it('falls back to the catalog model when pi omits the model object', async () => {
    setModelResult = {
      model: null,
      thinkingLevel: 'medium',
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high']
    }
    await useChatStore.getState().setModel(chatId, 'p2', 'b')
    await flush()
    const chat = useChatStore.getState().chats[chatId]!
    expect(chat.model?.id).toBe('b')
    expect(chat.thinkingLevel).toBe('medium')
  })

  it('keeps the previous level when the result omits it', async () => {
    setModelResult = {
      model: MODEL_B,
      thinkingLevel: null,
      thinkingLevels: ['off']
    }
    await useChatStore.getState().setModel(chatId, 'p2', 'b')
    await flush()
    const chat = useChatStore.getState().chats[chatId]!
    expect(chat.thinkingLevel).toBe('high')
    expect(chat.availableThinkingLevels).toEqual(['off'])
  })
})

describe('setCwd (project switch)', () => {
  let useChatStore: typeof import('./chat-store').useChatStore
  let seq = 0

  beforeEach(async () => {
    setCwdCalls = []
    setCwdHandler = null
    openHandler = null
    const mod = await import('./chat-store')
    useChatStore = mod.useChatStore
  })

  it('applies the new cwd immediately while pi restarts', async () => {
    const chatId = `sw${++seq}`
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await flush()

    let resolveSwitch: (value: unknown) => void = () => {}
    setCwdHandler = () => new Promise((r) => (resolveSwitch = r))
    const switching = useChatStore.getState().setCwd(chatId, '/tmp/other')

    // The composer chip reads chat.cwd — it must reflect the pick now, not
    // when the new pi finishes warming seconds later.
    expect(useChatStore.getState().chats[chatId]!.cwd).toBe('/tmp/other')
    expect(useChatStore.getState().chats[chatId]!.status).toBe('starting')

    resolveSwitch({
      chatId,
      cwd: '/tmp/other',
      state: { model: MODEL_A, thinkingLevel: 'high', isStreaming: false },
      messages: [],
      models: [MODEL_A],
      thinkingLevels: ['off', 'high'],
      commands: []
    })
    await switching
    await flush()
    expect(useChatStore.getState().chats[chatId]!.cwd).toBe('/tmp/other')
    expect(useChatStore.getState().chats[chatId]!.status).toBe('idle')
    expect(setCwdCalls).toEqual(['/tmp/other'])
  })

  it('reverts to the old cwd and reports the error when the reopen fails', async () => {
    const chatId = `sw${++seq}`
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await flush()

    setCwdHandler = () => Promise.reject(new Error('Invalid cwd'))
    await useChatStore.getState().setCwd(chatId, '/tmp/gone')
    await flush()
    const chat = useChatStore.getState().chats[chatId]!
    expect(chat.cwd).toBe('/tmp/synthetic')
    expect(chat.status).toBe('error')
    expect(chat.error).toContain('Invalid cwd')
  })

  it('ignores a stale open resolving after the user switched project', async () => {
    const chatId = `sw${++seq}`
    let resolveOpen: (value: unknown) => void = () => {}
    openHandler = () => new Promise((r) => (resolveOpen = r))
    const opening = useChatStore.getState().ensureChat(chatId, {
      cwd: '/tmp/synthetic'
    })

    // The user picks a project before the first open finishes: the chip must
    // show it immediately and a late result for the old cwd must not undo it.
    setCwdHandler = () =>
      Promise.resolve({
        chatId,
        cwd: '/tmp/other',
        state: { model: MODEL_A, thinkingLevel: 'high', isStreaming: false },
        messages: [],
        models: [MODEL_A],
        thinkingLevels: ['off', 'high'],
        commands: []
      })
    await useChatStore.getState().setCwd(chatId, '/tmp/other')
    expect(useChatStore.getState().chats[chatId]!.cwd).toBe('/tmp/other')

    resolveOpen({
      chatId,
      cwd: '/tmp/synthetic',
      state: { model: MODEL_A, thinkingLevel: 'high', isStreaming: false },
      messages: [],
      models: [MODEL_A],
      thinkingLevels: ['off', 'high'],
      commands: []
    })
    await opening
    await flush()
    expect(useChatStore.getState().chats[chatId]!.cwd).toBe('/tmp/other')
  })
})

describe('unread marker', () => {
  let useChatStore: typeof import('./chat-store').useChatStore
  let useAppStore: typeof import('./app-store').useAppStore
  let seq = 0

  beforeEach(async () => {
    openHandler = null
    const chatMod = await import('./chat-store')
    useChatStore = chatMod.useChatStore
    chatMod.initChatBridge()
    useAppStore = (await import('./app-store')).useAppStore
    useAppStore.setState({ view: { kind: 'home' } })
  })

  it('marks a background chat unread when its run settles, clears on markRead', async () => {
    const chatId = `u${++seq}`
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await flush()

    eventHandler!( {
      chatId,
      events: [{ type: 'agent_start' }, { type: 'agent_settled' }]
    })
    await flush()
    expect(useChatStore.getState().chats[chatId]!.unread).toBe(true)

    useChatStore.getState().markRead(chatId)
    await flush()
    expect(useChatStore.getState().chats[chatId]!.unread).toBe(false)
  })

  it('does not mark the visible chat unread', async () => {
    const chatId = `u${++seq}`
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await flush()
    useAppStore.setState({ view: { kind: 'chat', chatId } })

    eventHandler!({
      chatId,
      events: [{ type: 'agent_start' }, { type: 'agent_settled' }]
    })
    await flush()
    expect(useChatStore.getState().chats[chatId]!.unread ?? false).toBe(false)
  })
})
