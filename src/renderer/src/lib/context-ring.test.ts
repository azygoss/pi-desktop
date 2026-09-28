import { describe, expect, it } from 'vitest'

import type { ChatSessionStats } from '../../../shared/api'
import { contextRingVisible } from './context-ring'

const base: ChatSessionStats = {
  sessionFile: '/tmp/s.jsonl',
  sessionId: 's',
  userMessages: 2,
  assistantMessages: 2,
  toolCalls: 1,
  toolResults: 1,
  totalMessages: 5,
  tokens: { input: 120000, output: 32000, cacheRead: 4000, cacheWrite: 600, total: 156600 },
  cost: 0.42,
  contextUsage: { tokens: 156600, contextWindow: 200000, percent: 78.3 }
}

describe('contextRingVisible', () => {
  it('shows when usage is non-zero', () => {
    expect(contextRingVisible(base)).toBe(true)
  })

  it('hides without stats', () => {
    expect(contextRingVisible(undefined)).toBe(false)
  })

  it('hides for a fresh session reporting zeros', () => {
    expect(
      contextRingVisible({
        ...base,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 }
      })
    ).toBe(false)
  })
})
