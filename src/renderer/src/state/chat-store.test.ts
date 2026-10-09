// Node-environment test for the chat store: window.piDesktop and
// requestAnimationFrame are stubbed; only the store update paths run.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
let cuaHandler: ((payload: unknown) => void) | null = null
const reloadCalls: string[] = []

let setCwdCalls: string[] = []
let setCwdHandler:
  | ((input: { chatId: string; cwd: string }) => Promise<unknown>)
  | null = null
let openHandler:
  | ((input: { chatId: string }) => Promise<unknown>)
  | null = null
let sendHandler:
  | ((input: {
      chatId: string
      message: string
      images?: unknown[]
      mode: string
    }) => Promise<unknown>)
  | null = null

const sendCalls: { chatId: string; message: string; mode: string }[] = []
const notifyCalls: { chatId: string; title: string; body: string }[] = []

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
    // Stats refresh fires 150ms after a run settles — within a test's waits.
    getStats: async () => undefined,
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
    reload: async (input: { chatId: string }) => {
      reloadCalls.push(input.chatId)
      return {
        chatId: input.chatId,
        cwd: '/tmp/synthetic',
        state: { model: MODEL_A, thinkingLevel: 'high', isStreaming: false },
        messages: [],
        models: [MODEL_A],
        thinkingLevels: ['off', 'high'],
        commands: []
      }
    },
    send: async (input: {
      chatId: string
      message: string
      images?: unknown[]
      mode: string
    }) => {
      sendCalls.push(input)
      if (sendHandler) {
        await sendHandler(input)
      }
    },
    getForkMessages: async () => ({
      messages: [{ entryId: 'e0' }, { entryId: 'e1' }]
    }),
    fork: async () => ({ text: 'resend me' }),
    refresh: async (input: { chatId: string }) => ({
      chatId: input.chatId,
      cwd: '/tmp/synthetic',
      state: { model: MODEL_A, thinkingLevel: 'high', isStreaming: false },
      messages: [],
      models: [MODEL_A],
      thinkingLevels: ['off', 'high'],
      commands: []
    }),
    abort: async () => {},
    focus: async () => {}
  },
  app: {
    notify: async (input: { chatId: string; title: string; body: string }) => {
      notifyCalls.push(input)
    },
    setBadge: async () => {}
  },
  cua: {
    onActivity: (cb: (payload: unknown) => void) => {
      cuaHandler = cb
      return () => {}
    }
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

/** Longer than chat-store's streaming commit cap (MIN_FLUSH_INTERVAL_MS). */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 40))
}

describe('chat-store model switching', () => {
  let useChatStore: typeof import('./chat-store').useChatStore
  let seq = 0
  let chatId = ''

  beforeEach(async () => {
    setModelResult = null
    sendHandler = null
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

describe('computer-use activity', () => {
  let useChatStore: typeof import('./chat-store').useChatStore
  let useAppStore: typeof import('./app-store').useAppStore
  let seq = 0

  beforeEach(async () => {
    reloadCalls.length = 0
    const chatMod = await import('./chat-store')
    useChatStore = chatMod.useChatStore
    chatMod.initChatBridge()
    useAppStore = (await import('./app-store')).useAppStore
    useAppStore.setState({ view: { kind: 'home' } })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the strip on start, keeps a 4s tail after end, then hides', async () => {
    vi.useFakeTimers()
    const chatId = `cua${++seq}`
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await vi.advanceTimersByTimeAsync(40)

    cuaHandler!({
      chatId,
      phase: 'start',
      cmd: 'computer_click',
      app: 'Finder',
      summary: 'Clicked "Save"'
    })
    const chat = useChatStore.getState().chats[chatId]!
    expect(chat.cuaActive).toBe(true)
    expect(chat.cuaActivity?.app).toBe('Finder')
    expect(chat.cuaActivity?.summary).toBe('Clicked "Save"')

    cuaHandler!({
      chatId,
      phase: 'end',
      cmd: 'computer_click',
      app: 'Finder',
      summary: 'Clicked "Save"'
    })
    // Tail still running — strip stays.
    expect(useChatStore.getState().chats[chatId]!.cuaActive).toBe(true)
    await vi.advanceTimersByTimeAsync(3999)
    expect(useChatStore.getState().chats[chatId]!.cuaActive).toBe(true)
    await vi.advanceTimersByTimeAsync(40)
    expect(useChatStore.getState().chats[chatId]!.cuaActive).toBe(false)
  })

  it('clears the strip on agent_end without waiting for the tail', async () => {
    vi.useFakeTimers()
    const chatId = `cua${++seq}`
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await vi.advanceTimersByTimeAsync(40)

    cuaHandler!({
      chatId,
      phase: 'start',
      cmd: 'computer_state',
      app: 'Safari',
      summary: 'Read Safari'
    })
    expect(useChatStore.getState().chats[chatId]!.cuaActive).toBe(true)

    eventHandler!({ chatId, events: [{ type: 'agent_end' }] })
    await vi.advanceTimersByTimeAsync(40)
    const chat = useChatStore.getState().chats[chatId]!
    expect(chat.cuaActive).toBe(false)
  })

  it('mirrors service-wide pause/resume broadcasts', async () => {
    const chatId = `cua${++seq}`
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await flush()

    cuaHandler!({ phase: 'paused', cmd: '', summary: 'Paused' })
    await flush()
    expect(useChatStore.getState().chats[chatId]!.cuaPaused).toBe(true)
    cuaHandler!({ phase: 'resumed', cmd: '', summary: 'Resumed' })
    await flush()
    expect(useChatStore.getState().chats[chatId]!.cuaPaused).toBe(false)
  })

  it('restarts pi on the next send after markCuaStale', async () => {
    const chatId = `cua${++seq}`
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await flush()

    await useChatStore.getState().send(chatId, 'one', [], 'prompt')
    expect(reloadCalls).toEqual([])
    // Settle the turn so the next send is an idle prompt, not a steer.
    eventHandler!({ chatId, events: [{ type: 'agent_end' }, { type: 'agent_settled' }] })
    await flush()

    useChatStore.getState().markCuaStale(chatId)
    await useChatStore.getState().send(chatId, 'two', [], 'prompt')
    expect(reloadCalls).toEqual([chatId])
  })

  it('defers the cua reload while the chat is streaming', async () => {
    const chatId = `cua${++seq}`
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await flush()

    eventHandler!({ chatId, events: [{ type: 'agent_start' }] })
    await flush()
    useChatStore.getState().markCuaStale(chatId)
    // A send mid-run is a steer — it must not kill the in-flight pi.
    await useChatStore.getState().send(chatId, 'steer', [], 'prompt')
    expect(reloadCalls).toEqual([])

    eventHandler!({ chatId, events: [{ type: 'agent_end' }, { type: 'agent_settled' }] })
    await flush()
    await useChatStore.getState().send(chatId, 'next', [], 'prompt')
    expect(reloadCalls).toEqual([chatId])
  })
})

describe('retryFromUserMessage', () => {
  let useChatStore: typeof import('./chat-store').useChatStore
  let seq = 0

  beforeEach(async () => {
    sendCalls.length = 0
    reloadCalls.length = 0
    const mod = await import('./chat-store')
    useChatStore = mod.useChatStore
  })

  it('forks at the user message and re-sends its text without a composer seed', async () => {
    const chatId = `r${++seq}`
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await flush()
    await useChatStore.getState().send(chatId, 'resend me', undefined, 'prompt')
    eventHandler!({ chatId, events: [{ type: 'agent_end' }, { type: 'agent_settled' }] })
    await flush()

    await useChatStore.getState().retryFromUserMessage(chatId, 0)
    const last = sendCalls[sendCalls.length - 1]!
    expect(last.message).toBe('resend me')
    expect(last.mode).toBe('prompt')
    // The fork path seeds the composer for editing; retry clears it.
    const seed = useChatStore.getState().chats[chatId]!.composerSeed
    expect(seed).toBeDefined()
    expect(seed!.text).toBe('')
  })

  it('does nothing for an out-of-range user index', async () => {
    const chatId = `r${++seq}`
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await flush()
    await useChatStore.getState().retryFromUserMessage(chatId, 9)
    expect(sendCalls).toEqual([])
  })
})

describe('retryFailedPrompt', () => {
  let useChatStore: typeof import('./chat-store').useChatStore
  let seq = 0

  beforeEach(async () => {
    sendCalls.length = 0
    sendHandler = null
    const mod = await import('./chat-store')
    useChatStore = mod.useChatStore
  })

  it('records the failed prompt and resends it once on retry', async () => {
    const chatId = `f${++seq}`
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await flush()

    sendHandler = async () => {
      throw new Error('synthetic failure')
    }
    // send() records the failure on the draft and rethrows for callers.
    await expect(
      useChatStore.getState().send(chatId, 'fail me', undefined, 'prompt')
    ).rejects.toThrow('synthetic failure')
    await flush()
    let chat = useChatStore.getState().chats[chatId]!
    expect(chat.error).toBe('synthetic failure')
    expect(chat.failedPrompt?.text).toBe('fail me')
    expect(chat.messages).toHaveLength(1)

    sendHandler = null
    await useChatStore.getState().retryFailedPrompt(chatId)
    await flush()
    chat = useChatStore.getState().chats[chatId]!
    expect(chat.error).toBeUndefined()
    expect(chat.failedPrompt).toBeUndefined()
    // Still exactly one user message: the failed echo was replaced.
    expect(chat.messages.filter((m) => m.kind === 'user')).toHaveLength(1)
    expect(sendCalls).toHaveLength(2)
    expect(sendCalls[1]!.message).toBe('fail me')
  })

  it('does nothing when no prompt failed', async () => {
    const chatId = `f${++seq}`
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await flush()
    await useChatStore.getState().retryFailedPrompt(chatId)
    expect(sendCalls).toEqual([])
  })
})

describe('run-settled notifications', () => {
  let useChatStore: typeof import('./chat-store').useChatStore
  let useAppStore: typeof import('./app-store').useAppStore
  let seq = 0

  beforeEach(async () => {
    notifyCalls.length = 0
    const chatMod = await import('./chat-store')
    useChatStore = chatMod.useChatStore
    chatMod.initChatBridge()
    useAppStore = (await import('./app-store')).useAppStore
    useAppStore.setState({ view: { kind: 'home' } })
  })

  it('notifies with the last assistant text when a background run settles', async () => {
    const chatId = `n${++seq}`
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await flush()
    eventHandler!({
      chatId,
      events: [
        { type: 'agent_start' },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '**Done** — `fixed` the bug' }],
            api: 'test',
            provider: 'p',
            model: 'm',
            usage: {},
            stopReason: 'endTurn',
            timestamp: 1
          }
        },
        { type: 'agent_settled' }
      ]
    })
    await flush()
    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0]!.chatId).toBe(chatId)
    expect(notifyCalls[0]!.body).toBe('Done — fixed the bug')
  })

  it('says "Stopped with an error" when the run errored', async () => {
    const chatId = `n${++seq}`
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await flush()
    const draft = useChatStore.getState().chats[chatId]!
    expect(draft).toBeDefined()
    // Simulate an errored turn: status goes to error, then settled fires.
    eventHandler!({ chatId, events: [{ type: 'agent_start' }] })
    await flush()
    eventHandler!({ chatId, events: [{ type: 'agent_settled' }] })
    await flush()
    expect(notifyCalls).toHaveLength(1)
  })

  it('does not notify when notifications are disabled', async () => {
    const chatId = `n${++seq}`
    useAppStore.setState((s) => ({
      appSettings: { ...s.appSettings, notifications: { enabled: false } }
    }))
    await useChatStore.getState().ensureChat(chatId, { cwd: '/tmp/synthetic' })
    await flush()
    eventHandler!({
      chatId,
      events: [{ type: 'agent_start' }, { type: 'agent_settled' }]
    })
    await flush()
    expect(notifyCalls).toEqual([])
    useAppStore.setState((s) => ({
      appSettings: { ...s.appSettings, notifications: { enabled: true } }
    }))
  })
})
