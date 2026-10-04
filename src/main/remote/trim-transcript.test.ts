import { describe, expect, it } from 'vitest'

import type { AgentMessage } from '../../shared/pi-types'
import { trimTranscript } from './trim-transcript'

describe('trimTranscript', () => {
  it('cuts the middle out of long tool output and leaves the rest alone', () => {
    const long = `${'a'.repeat(6000)}${'b'.repeat(20_000)}${'c'.repeat(3000)}`
    const messages = [
      { role: 'user', content: 'x'.repeat(20_000), timestamp: 1 },
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'bash',
        isError: false,
        content: [
          { type: 'text', text: long },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' }
        ]
      },
      {
        role: 'toolResult',
        toolCallId: 't2',
        toolName: 'read',
        isError: false,
        content: [{ type: 'text', text: 'short' }]
      }
    ] as unknown as AgentMessage[]
    const trimmed = trimTranscript(messages)
    expect(trimmed[0]).toBe(messages[0])
    expect(trimmed[2]).toBe(messages[2])
    const result = trimmed[1] as Extract<AgentMessage, { role: 'toolResult' }>
    const text = (result.content[0] as { text: string }).text
    expect(text.length).toBeLessThan(8000)
    expect(text.startsWith('a'.repeat(5000))).toBe(true)
    expect(text.endsWith('c'.repeat(2500))).toBe(true)
    expect(text).toContain('characters not sent to the phone')
    expect(result.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
    // The input is not modified.
    expect(((messages[1] as typeof result).content[0] as { text: string }).text).toBe(long)
  })
})
