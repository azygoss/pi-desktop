import { describe, expect, it } from 'vitest'

import {
  changePeek,
  formatDuration,
  shellStatusLabel,
  splitShellStatus,
  thinkingExcerpt
} from './trace'

describe('splitShellStatus', () => {
  it('leaves clean output alone', () => {
    expect(splitShellStatus('total 8\nfile.txt')).toEqual({ output: 'total 8\nfile.txt' })
  })

  it('splits a non-zero exit status off the output', () => {
    expect(splitShellStatus('boom\n\nCommand exited with code 2')).toEqual({
      output: 'boom',
      status: { kind: 'exit', code: 2 }
    })
    expect(splitShellStatus('Command exited with code 1')).toEqual({
      output: '',
      status: { kind: 'exit', code: 1 }
    })
  })

  it('recognizes timeouts and aborts', () => {
    expect(splitShellStatus('partial\n\nCommand timed out after 30 seconds').status).toEqual({
      kind: 'timeout',
      seconds: 30
    })
    expect(splitShellStatus('Command aborted').status).toEqual({ kind: 'aborted' })
  })

  it('ignores a status phrase in the middle of the output', () => {
    const text = 'Command exited with code 3\nmore output'
    expect(splitShellStatus(text)).toEqual({ output: text })
  })
})

describe('shellStatusLabel', () => {
  it('labels each status', () => {
    expect(shellStatusLabel({ kind: 'exit', code: 127 })).toBe('exit 127')
    expect(shellStatusLabel({ kind: 'timeout', seconds: 5 })).toBe('timed out')
    expect(shellStatusLabel({ kind: 'aborted' })).toBe('aborted')
  })
})

describe('formatDuration', () => {
  it('formats sub-second, seconds and minutes', () => {
    expect(formatDuration(420)).toBe('0.4s')
    expect(formatDuration(12_300)).toBe('12s')
    expect(formatDuration(125_000)).toBe('2m 05s')
  })
})

describe('thinkingExcerpt', () => {
  const text = '**Planning the refactor**\n\nFirst I will read the parser.\nThen patch `split()`.\n'

  it('opens with the heading and the prose that follows once done', () => {
    expect(thinkingExcerpt(text, false)).toBe(
      'Planning the refactor — First I will read the parser. Then patch split().'
    )
  })

  it('shows the tail while live', () => {
    expect(thinkingExcerpt(text, true).endsWith('Then patch split().')).toBe(true)
  })

  it('handles empty text and trims long thoughts', () => {
    expect(thinkingExcerpt('', true)).toBe('')
    const long = 'word '.repeat(200)
    expect(thinkingExcerpt(long, false).endsWith('…')).toBe(true)
    expect(thinkingExcerpt(long, true).startsWith('…')).toBe(true)
  })
})

describe('changePeek', () => {
  it('shows only the changed lines of an edit', () => {
    const peek = changePeek('edit', {
      edits: [{ oldText: 'a\nb = 1\nc', newText: 'a\nb = 2\nc' }]
    })
    expect(peek).toEqual({
      lines: [
        { sign: '-', text: 'b = 1' },
        { sign: '+', text: 'b = 2' }
      ],
      more: 0
    })
  })

  it('counts what the peek leaves out across edits', () => {
    const peek = changePeek('edit', {
      edits: [
        { oldText: 'x1\nx2\nx3', newText: 'y1\ny2\ny3' },
        { oldText: 'z', newText: 'w' }
      ]
    })
    expect(peek?.lines).toHaveLength(4)
    expect(peek?.more).toBe(4)
  })

  it('previews the first lines of a written file', () => {
    expect(changePeek('write', { content: 'one\ntwo\nthree\nfour\n' })).toEqual({
      lines: [
        { sign: '+', text: 'one' },
        { sign: '+', text: 'two' },
        { sign: '+', text: 'three' }
      ],
      more: 1
    })
  })

  it('returns null when there is nothing to show', () => {
    expect(changePeek('write', {})).toBeNull()
    expect(changePeek('edit', { oldText: 'same', newText: 'same' })).toBeNull()
    expect(changePeek('edit', {})).toBeNull()
  })
})
