import { describe, expect, it } from 'vitest'

import type { PiCommandInfo } from '../../../shared/pi-types'
import {
  filterSlashCommands,
  findAppCommand,
  flattenSlashGroups,
  parseSlashSend,
  slashQuery
} from './slash-commands'

const PI_COMMANDS: PiCommandInfo[] = [
  { name: 'review-code', description: 'Review staged changes', source: 'prompt' },
  { name: 'skill:search', description: 'Semantic code search', source: 'skill' },
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
  it('groups items as App, Skills, Prompts, Extensions', () => {
    const groups = filterSlashCommands(PI_COMMANDS, '', true)
    expect(groups.map((g) => g.label)).toEqual(['App', 'Skills', 'Prompts', 'Extensions'])
    const skill = groups[1]!.items[0]!
    expect(skill.name).toBe('skill:search')
    const prompt = groups[2]!.items[0]!
    expect(prompt.name).toBe('review-code')
  })

  it('matches name and description', () => {
    const byName = flattenSlashGroups(filterSlashCommands(PI_COMMANDS, 'stag', true))
    expect(byName.map((i) => i.name)).toContain('review-code')
    const byDesc = flattenSlashGroups(filterSlashCommands(PI_COMMANDS, 'semantic', true))
    expect(byDesc.map((i) => i.name)).toEqual(['skill:search'])
  })

  it('hides chat-only app commands outside a chat and idle-only while streaming', () => {
    const names = flattenSlashGroups(filterSlashCommands(PI_COMMANDS, '', false)).map(
      (i) => i.name
    )
    expect(names).toContain('new')
    expect(names).not.toContain('compact')
    expect(names).not.toContain('session')

    const streaming = flattenSlashGroups(filterSlashCommands([], '', true, true)).map(
      (i) => i.name
    )
    expect(streaming).not.toContain('fork')
    expect(streaming).not.toContain('share')
    expect(streaming).toContain('new')
  })
})

describe('APP_COMMANDS / findAppCommand', () => {
  it('covers every pi built-in command from docs/slash-commands.md', () => {
    const builtins = [
      'settings',
      'model',
      'thinking',
      'scoped-models',
      'login',
      'logout',
      'llama',
      'new',
      'resume',
      'name',
      'session',
      'tree',
      'fork',
      'clone',
      'compact',
      'import',
      'copy',
      'export',
      'share',
      'bug',
      'trust',
      'reload',
      'hotkeys',
      'changelog',
      'quit'
    ]
    for (const name of builtins) {
      expect(findAppCommand(name), `missing /${name}`).toBeTruthy()
    }
  })

  it('marks TUI-only commands as terminal commands', () => {
    for (const name of ['scoped-models', 'login', 'logout', 'llama', 'trust', 'share', 'bug']) {
      const cmd = findAppCommand(name)
      expect(cmd?.terminal, `/${name}`).toBe(true)
      expect(cmd?.hint).toBe('opens in terminal')
    }
  })

  it('does not flag local or pi commands as app commands', () => {
    expect(findAppCommand('new')?.source).toBe('app')
    expect(findAppCommand('review-code')).toBeUndefined()
  })
})
