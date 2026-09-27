import { describe, expect, it } from 'vitest'

import { createJsonlReader } from './jsonl'

describe('createJsonlReader', () => {
  it('emits complete lines', () => {
    const lines: string[] = []
    const reader = createJsonlReader((l) => lines.push(l))
    reader.push('{"a":1}\n{"b":2}\n')
    reader.end()
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('splits only on \\n, keeping U+2028/U+2029 inside JSON strings', () => {
    const lines: string[] = []
    const reader = createJsonlReader((l) => lines.push(l))
    const payload = '{"text":"one\u2028two\u2029three"}'
    reader.push(payload + '\n')
    reader.end()
    expect(lines).toEqual([payload])
    expect(JSON.parse(lines[0]!).text).toBe('one\u2028two\u2029three')
  })

  it('handles multi-byte UTF-8 characters split across chunks', () => {
    const lines: string[] = []
    const reader = createJsonlReader((l) => lines.push(l))
    const bytes = Buffer.from('{"emoji":"🎉"}\n', 'utf8')
    // Split inside the 4-byte emoji sequence.
    const cut = bytes.indexOf(0xf0)
    reader.push(bytes.subarray(0, cut + 1))
    reader.push(bytes.subarray(cut + 1))
    reader.end()
    expect(lines).toEqual(['{"emoji":"🎉"}'])
  })

  it('strips a trailing \\r for CRLF input', () => {
    const lines: string[] = []
    const reader = createJsonlReader((l) => lines.push(l))
    reader.push('{"a":1}\r\n{"b":2}\r\n')
    reader.end()
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('skips empty lines', () => {
    const lines: string[] = []
    const reader = createJsonlReader((l) => lines.push(l))
    reader.push('{"a":1}\n\n\n{"b":2}\n')
    reader.end()
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('flushes trailing data without a newline on end()', () => {
    const lines: string[] = []
    const reader = createJsonlReader((l) => lines.push(l))
    reader.push('{"a":1}\n{"tail":true}')
    reader.end()
    expect(lines).toEqual(['{"a":1}', '{"tail":true}'])
  })

  it('ignores pushes after end()', () => {
    const lines: string[] = []
    const reader = createJsonlReader((l) => lines.push(l))
    reader.push('{"a":1}\n')
    reader.end()
    reader.push('{"b":2}\n')
    expect(lines).toEqual(['{"a":1}'])
  })
})
