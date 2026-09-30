import { describe, expect, it } from 'vitest'

import { formatDuration, shellStatusLabel, splitShellStatus } from './trace'

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
