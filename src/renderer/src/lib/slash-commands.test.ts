import { describe, expect, it } from 'vitest'

import type { PiCommandInfo } from '../../../shared/pi-types'
import {
  APP_COMMANDS,
  filterSlashCommands,
  isAppCommand,
  parseSlashSend,
  slashQuery
} from './slash-commands'

const PI_COMMANDS: PiCommandInfo[] = [
  { name: 'review-code', description: 'Review staged changes', source: 'prompt' },
  { name: 'skill:search', description: 'Search', source: 'skill' },
  { name: 'session-name', description: 'Set name', source: 'extension' }
]

describe('slashQuery', () => {
  it('returns the typed token while a single slash token is being typed', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/na')).toBe('na')
    expect(slashQuery('/model')).toBe('model')
  })

  it('returns null once an argument or non-slash text is present', () => {
    expect(slashQuery('/name foo')).toBeNull()
    expect(slashQuery('hello')).toBeNull()
    expect(slashQuery(' /x')).toBeNull()
    expect(slashQuery('a/b')).toBeNull()
  })
})

describe('parseSlashSend', () => {
  it('splits command and args', () => {
    expect(parseSlashSend('/new')).toEqual({ command: 'new', args: '' })
    expect(parseSlashSend('/name My chat')).toEqual({ command: 'name', args: 'My chat' })
    expect(parseSlashSend('/compact   keep it short  ')).toEqual({
      command: 'compact',
      args: 'keep it short'
    })
  })

  it('returns null for non-command text', () => {
    expect(parseSlashSend('hello /there')).toBeNull()
    expect(parseSlashSend('/')).toBeNull()
  })
})

describe('filterSlashCommands', () => {
  it('puts app commands first and filters by token', () => {
    const items = filterSlashCommands(PI_COMMANDS, 'n', true)
    expect(items[0]).toMatchObject({ name: 'new', source: 'app' })
    expect(items.map((i) => i.name)).toContain('session-name')
  })

  it('hides chat-only app commands outside a chat', () => {
    const items = filterSlashCommands(PI_COMMANDS, '', false)
    const names = items.map((i) => i.name)
    expect(names).toContain('new')
    expect(names).not.toContain('compact')
    expect(names).not.toContain('export')
  })

  it('includes pi commands with their source', () => {
    const items = filterSlashCommands(PI_COMMANDS, '', true)
    const skill = items.find((i) => i.name === 'skill:search')
    expect(skill?.source).toBe('skill')
  })
})

describe('APP_COMMANDS / isAppCommand', () => {
  it('recognizes local commands only', () => {
    expect(isAppCommand('new')).toBe(true)
    expect(isAppCommand('review-code')).toBe(false)
    expect(APP_COMMANDS.length).toBe(6)
  })
})
