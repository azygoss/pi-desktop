import { describe, expect, it, vi } from 'vitest'

import type { PiEvent } from '../../shared/pi-types'
import { EventCoalescer } from './event-coalescer'

function delta(text: string): PiEvent {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: text, contentIndex: 0 }
  } as unknown as PiEvent
}

const OTHER: PiEvent = { type: 'agent_start' } as unknown as PiEvent

function collect(): { batches: PiEvent[][]; emit: (events: PiEvent[]) => void } {
  const batches: PiEvent[][] = []
  return { batches, emit: (events) => batches.push(events) }
}

describe('EventCoalescer', () => {
  it('buffers message_update deltas into one 32ms batch', () => {
    vi.useFakeTimers()
    try {
      const { batches, emit } = collect()
      const coalescer = new EventCoalescer(emit)
      coalescer.push(delta('a'))
      coalescer.push(delta('b'))
      coalescer.push(delta('c'))
      expect(batches).toHaveLength(0)
      vi.advanceTimersByTime(32)
      expect(batches).toHaveLength(1)
      expect(batches[0]).toHaveLength(3)
      coalescer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes immediately on a non-delta event, preserving order', () => {
    const { batches, emit } = collect()
    const coalescer = new EventCoalescer(emit)
    coalescer.push(delta('x'))
    coalescer.push(OTHER)
    // Immediate flush: [delta, other] in one ordered payload.
    expect(batches).toHaveLength(1)
    expect(batches[0]!.map((e) => e.type)).toEqual(['message_update', 'agent_start'])
    coalescer.dispose()
  })

  it('starts a new batch after a flush', () => {
    vi.useFakeTimers()
    try {
      const { batches, emit } = collect()
      const coalescer = new EventCoalescer(emit)
      coalescer.push(delta('1'))
      vi.advanceTimersByTime(32)
      coalescer.push(delta('2'))
      vi.advanceTimersByTime(32)
      expect(batches).toHaveLength(2)
      expect(batches[0]).toHaveLength(1)
      expect(batches[1]).toHaveLength(1)
      coalescer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits non-delta events alone when the buffer is empty', () => {
    const { batches, emit } = collect()
    const coalescer = new EventCoalescer(emit)
    coalescer.push(OTHER)
    expect(batches).toEqual([[OTHER]])
    coalescer.dispose()
  })

  it('drops pending deltas on dispose', () => {
    vi.useFakeTimers()
    try {
      const { batches, emit } = collect()
      const coalescer = new EventCoalescer(emit)
      coalescer.push(delta('lost'))
      coalescer.dispose()
      vi.advanceTimersByTime(100)
      expect(batches).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
