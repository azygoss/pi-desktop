import { describe, expect, it } from 'vitest'

import { parseSkillPrefix, titleFromUserText } from './skill-prefix'

describe('parseSkillPrefix', () => {
  it('returns the text untouched when there is no skill block', () => {
    expect(parseSkillPrefix('hello world')).toEqual({ skills: [], rest: 'hello world' })
  })

  it('strips a single leading skill block', () => {
    const { skills, rest } = parseSkillPrefix(
      '<skill name="build-ios" location="/Users/example/.pi/skills/build-ios/SKILL.md">do ios stuff</skill> ship it'
    )
    expect(skills).toEqual([
      { name: 'build-ios', location: '/Users/example/.pi/skills/build-ios/SKILL.md', body: 'do ios stuff' }
    ])
    expect(rest).toBe('ship it')
  })

  it('handles several leading skill blocks', () => {
    const { skills, rest } = parseSkillPrefix(
      '<skill name="a" location="/x">1</skill>\n<skill name="b" location="/y">2</skill>\nrun both'
    )
    expect(skills.map((s) => s.name)).toEqual(['a', 'b'])
    expect(rest).toBe('run both')
  })

  it('tolerates attribute order, extra attributes and whitespace', () => {
    const { skills, rest } = parseSkillPrefix(
      '  <skill  location="/p"  name="z" extra="1">\nbody\n</skill>\n\ntext'
    )
    expect(skills[0]).toMatchObject({ name: 'z', location: '/p', body: 'body' })
    expect(rest).toBe('text')
  })

  it('does not strip a skill block that is not at the start', () => {
    const { skills, rest } = parseSkillPrefix('hi <skill name="x">y</skill>')
    expect(skills).toEqual([])
    expect(rest).toBe('hi <skill name="x">y</skill>')
  })

  it('leaves unclosed skill markup alone', () => {
    const { skills, rest } = parseSkillPrefix('<skill name="x">oops')
    expect(skills).toEqual([])
    expect(rest).toBe('<skill name="x">oops')
  })
})

describe('titleFromUserText', () => {
  it('uses the typed remainder', () => {
    expect(titleFromUserText('<skill name="a" location="/x">b</skill> fix the bug')).toBe(
      'fix the bug'
    )
  })

  it('falls back to /skill:name when the message was only an invocation', () => {
    expect(titleFromUserText('<skill name="a" location="/x">b</skill>')).toBe('/skill:a')
  })

  it('passes plain text through', () => {
    expect(titleFromUserText('plain')).toBe('plain')
    expect(titleFromUserText(undefined)).toBeUndefined()
  })

  it('strips leading image paths (synthetic temp paths)', () => {
    expect(
      titleFromUserText('/tmp/synthetic/pi-clipboard-1.png what does this show?')
    ).toBe('what does this show?')
    expect(
      titleFromUserText('/var/folders/xx/synthetic.png\n/var/folders/yy/synthetic.jpg\nlook at these')
    ).toBe('look at these')
    expect(
      titleFromUserText('file:///tmp/synthetic/shot.webp describe it')
    ).toBe('describe it')
  })

  it('falls back to "Image" when only pasted images remain', () => {
    expect(titleFromUserText('/tmp/synthetic/pi-clipboard-1.png')).toBe('Image')
    expect(titleFromUserText('~/shots/a.png /tmp/b.jpeg')).toBe('Image')
    expect(
      titleFromUserText('<skill name="a" location="/x">b</skill> /tmp/synthetic/c.png')
    ).toBe('Image')
  })

  it('keeps non-image paths and mid-text image mentions', () => {
    expect(titleFromUserText('/opt/synthetic/project fix the build')).toBe(
      '/opt/synthetic/project fix the build'
    )
    expect(titleFromUserText('the file /tmp/x.png is broken')).toBe(
      'the file /tmp/x.png is broken'
    )
  })
})
