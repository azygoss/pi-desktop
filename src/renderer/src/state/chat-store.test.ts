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

const fakeApi = {
  chat: {
    open: async (input: { chatId: string }) => ({
      chatId: input.chatId,
      cwd: '/tmp/synthetic',
      state: { model: MODEL_A, thinkingLevel: 'high', isStreaming: false },
      messages: [],
      models: [MODEL_A, MODEL_B],
      thinkingLevels: ['off', 'low', 'medium', 'high'],
      commands: []
    }),
    setModel: async () => setModelResult
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
