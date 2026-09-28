import { describe, expect, it } from 'vitest'

import {
  appendAttachmentRefs,
  attachmentRef,
  formatMention,
  looksLikePath,
  mentionTrigger,
  splitMentions
} from './mentions'

describe('mentionTrigger', () => {
  it('triggers at a token boundary', () => {
    expect(mentionTrigger('@', 1)).toEqual({ start: 0, end: 1, query: '' })
    expect(mentionTrigger('hi @no', 6)).toEqual({ start: 3, end: 6, query: 'no' })
    expect(mentionTrigger('see @src/a.ts ', 12)).toEqual({ start: 4, end: 12, query: 'src/a.t' })
  })

  it('supports the quoted @"…" form with spaces', () => {
    expect(mentionTrigger('@"a b/c', 7)).toEqual({ start: 0, end: 7, query: 'a b/c' })
    // A closed quote no longer triggers.
    expect(mentionTrigger('@"a b" and x', 12)).toBeNull()
  })

  it('rejects mid-word @ (emails)', () => {
    expect(mentionTrigger('mail me@example', 15)).toBeNull()
    expect(mentionTrigger('a@b', 3)).toBeNull()
  })

  it('rejects @ inside code spans and fences', () => {
    expect(mentionTrigger('run `@cmd now', 12)).toBeNull()
    expect(mentionTrigger('```\n@file\n```', 9)).toBeNull()
    // Closed fence + closed span trigger again.
    expect(mentionTrigger('`code` @ok', 10)).not.toBeNull()
    expect(mentionTrigger('```\ncode\n```\n@ok', 16)).not.toBeNull()
  })

  it('does not trigger on a bare @ at end of a longer token', () => {
    expect(mentionTrigger('foo@', 4)).toBeNull()
  })
})

describe('formatMention / attachmentRef', () => {
  it('quotes only paths containing spaces', () => {
    expect(formatMention('src/a.ts')).toBe('@src/a.ts')
    expect(formatMention('a b/c.ts')).toBe('@"a b/c.ts"')
  })

  it('makes paths relative to the chat cwd', () => {
    expect(attachmentRef('/repo/src/a.ts', '/repo')).toBe('@src/a.ts')
    expect(attachmentRef('/other/x.md', '/repo')).toBe('@/other/x.md')
    expect(attachmentRef('/repo/a b.txt', '/repo')).toBe('@"a b.txt"')
  })

  it('appends refs after the text, one per line', () => {
    expect(appendAttachmentRefs('hi', ['/r/a.ts', '/o/b c.md'], '/r')).toBe(
      'hi\n@a.ts\n@"/o/b c.md"'
    )
    expect(appendAttachmentRefs('', ['/r/a.ts'], '/r')).toBe('@a.ts')
    expect(appendAttachmentRefs('hi', [], '/r')).toBe('hi')
  })
})

describe('looksLikePath', () => {
  it('requires a slash or extension', () => {
    expect(looksLikePath('src/a.ts')).toBe(true)
    expect(looksLikePath('notes.txt')).toBe(true)
    expect(looksLikePath('username')).toBe(false)
    expect(looksLikePath('example.com')).toBe(true) // has an extension — acceptable
  })
})

describe('splitMentions', () => {
  it('splits plain and quoted mentions', () => {
    expect(splitMentions('see @src/a.ts and @"b c.md" ok')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'mention', text: '@src/a.ts', path: 'src/a.ts' },
      { type: 'text', text: ' and ' },
      { type: 'mention', text: '@"b c.md"', path: 'b c.md' },
      { type: 'text', text: ' ok' }
    ])
  })

  it('leaves @names and emails as text', () => {
    expect(splitMentions('thanks @alice')).toEqual([
      { type: 'text', text: 'thanks @alice' }
    ])
    expect(splitMentions('mail me@x.com now')).toEqual([
      { type: 'text', text: 'mail me@x.com now' }
    ])
  })

  it('handles multiple mentions per line', () => {
    expect(splitMentions('@a.ts\n@b/c.md')).toEqual([
      { type: 'mention', text: '@a.ts', path: 'a.ts' },
      { type: 'text', text: '\n' },
      { type: 'mention', text: '@b/c.md', path: 'b/c.md' }
    ])
  })
})
