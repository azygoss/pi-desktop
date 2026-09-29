import { describe, expect, it } from 'vitest'

import { splitMarkdownBlocks } from './markdown-blocks'

describe('splitMarkdownBlocks', () => {
  it('splits paragraphs and headings at blank lines', () => {
    expect(splitMarkdownBlocks('# Title\n\nFirst para.\n\nSecond para.')).toEqual([
      '# Title\n',
      'First para.\n',
      'Second para.'
    ])
  })

  it('round-trips: chunks joined with newlines equal the input', () => {
    const text = 'a\n\n```ts\nx\n\ny\n```\n\n- one\n\n- two\n\ntail'
    expect(splitMarkdownBlocks(text).join('\n')).toBe(text)
  })

  it('keeps blank lines inside fenced code in one chunk', () => {
    const chunks = splitMarkdownBlocks('intro\n\n```py\na = 1\n\nb = 2\n```\n\nafter')
    expect(chunks).toEqual(['intro\n', '```py\na = 1\n\nb = 2\n```\n', 'after'])
  })

  it('treats an unclosed fence (mid-stream) as running to the end', () => {
    expect(splitMarkdownBlocks('intro\n\n```\ncode\n\nmore')).toEqual([
      'intro\n',
      '```\ncode\n\nmore'
    ])
  })

  it('only closes a fence with the same marker and enough length', () => {
    const chunks = splitMarkdownBlocks('````\n```\n\nstill code\n````\n\nafter')
    expect(chunks).toEqual(['````\n```\n\nstill code\n````\n', 'after'])
  })

  it('keeps loose lists and indented continuations together', () => {
    const text = '- one\n\n- two\n\n  continued\n\n1. a\n\n2. b'
    expect(splitMarkdownBlocks(text)).toEqual([text])
  })

  it('does not split before indented code', () => {
    expect(splitMarkdownBlocks('para\n\n    code line')).toEqual(['para\n\n    code line'])
  })

  it('disables splitting for reference links, footnotes and raw HTML', () => {
    for (const text of [
      'see [x]\n\nmore\n\n[x]: https://example.com',
      'note[^1]\n\nmore\n\n[^1]: footnote',
      '<!--\n\ncomment\n\n-->',
      '<pre>\n\nraw\n\n</pre>'
    ]) {
      expect(splitMarkdownBlocks(text)).toEqual([text])
    }
  })
})
