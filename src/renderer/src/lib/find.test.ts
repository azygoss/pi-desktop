import { describe, expect, it } from 'vitest'

import type { DisplayMessage, ToolRun } from '../../../shared/chat-view'
import {
  countOccurrences,
  findMatches,
  locateOccurrence,
  messageSearchText,
  totalOccurrences
} from './find'

const user = (text: string): DisplayMessage => ({
  kind: 'user',
  key: `u-${text}`,
  text,
  images: []
})

const emptyAssistant: DisplayMessage = { kind: 'assistant', key: 'a0', blocks: [] }

describe('countOccurrences', () => {
  it('counts case-insensitive substrings', () => {
    expect(countOccurrences('Hello hello HELLO', 'hello')).toBe(3)
    expect(countOccurrences('abc', '')).toBe(0)
    expect(countOccurrences('aaaa', 'aa')).toBe(2)
  })
})

describe('messageSearchText', () => {
  it('returns user text', () => {
    expect(messageSearchText(user('fix the tests'), {})).toBe('fix the tests')
  })

  it('returns assistant text blocks plus tool summary lines', () => {
    const message: DisplayMessage = {
      kind: 'assistant',
      key: 'a1',
      blocks: [
        { type: 'thinking', thinking: 'hidden reasoning' },
        { type: 'text', text: 'I will read the file' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/repo/app.ts' } },
        { type: 'text', text: 'done' }
      ]
    }
    const text = messageSearchText(message, {}, '/repo')
    expect(text).toContain('I will read the file')
    expect(text).toContain('done')
    expect(text).toContain('read app.ts')
    expect(text).not.toContain('hidden reasoning')
  })

  it('excludes tool output bodies', () => {
    const message: DisplayMessage = {
      kind: 'assistant',
      key: 'a1',
      blocks: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }]
    }
    const runs: Record<string, ToolRun> = {
      c1: {
        toolCallId: 'c1',
        name: 'read',
        args: {},
        status: 'done',
        result: { content: [{ type: 'text', text: 'secret output body' }] }
      }
    }
    expect(messageSearchText(message, runs)).not.toContain('secret output body')
  })
})

describe('findMatches', () => {
  const messages: DisplayMessage[] = [
    user('run the tests'),
    emptyAssistant,
    user('tests again')
  ]

  it('matches per message in order with counts', () => {
    const withText: DisplayMessage[] = [
      user('run the tests'),
      {
        kind: 'assistant',
        key: 'a',
        blocks: [{ type: 'text', text: 'tests tests' }]
      },
      user('tests again')
    ]
    expect(findMatches(withText, {}, 'tests')).toEqual([
      { messageIndex: 0, count: 1 },
      { messageIndex: 1, count: 2 },
      { messageIndex: 2, count: 1 }
    ])
    expect(totalOccurrences(findMatches(withText, {}, 'tests'))).toBe(4)
  })

  it('returns empty for blank or missing queries', () => {
    expect(findMatches(messages, {}, '')).toEqual([])
    expect(findMatches(messages, {}, 'zzz')).toEqual([])
  })
})

describe('locateOccurrence', () => {
  const matches = [
    { messageIndex: 0, count: 2 },
    { messageIndex: 3, count: 3 }
  ]

  it('maps a global ordinal to message and intra-message index', () => {
    expect(locateOccurrence(matches, 0)).toEqual({ matchIndex: 0, occurrenceInMessage: 0 })
    expect(locateOccurrence(matches, 1)).toEqual({ matchIndex: 0, occurrenceInMessage: 1 })
    expect(locateOccurrence(matches, 2)).toEqual({ matchIndex: 1, occurrenceInMessage: 0 })
    expect(locateOccurrence(matches, 4)).toEqual({ matchIndex: 1, occurrenceInMessage: 2 })
    expect(locateOccurrence(matches, 5)).toBeNull()
  })
})
