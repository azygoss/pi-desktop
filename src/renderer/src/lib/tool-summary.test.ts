import { describe, expect, it } from 'vitest'

import {
  computerGroupApp,
  computerToolSummary,
  formatKeyChord,
  summarizeToolNames,
  summarizeToolRuns,
  toolCategory
} from './tool-summary'

describe('summarizeToolNames', () => {
  it('counts files read and edited', () => {
    expect(summarizeToolNames(['read', 'read', 'edit'])).toBe('read 2 files, edited 1 file')
  })

  it('counts shell commands', () => {
    expect(summarizeToolNames(['bash', 'bash'])).toBe('ran 2 commands')
  })

  it('groups browser tools', () => {
    expect(summarizeToolNames(['browser_open', 'browser_click'])).toBe('browser ×2')
  })

  it('falls back to the tool name for unknown tools', () => {
    expect(summarizeToolNames(['web_search'])).toBe('web_search')
    expect(summarizeToolNames(['web_search', 'web_search', 'web_search'])).toBe('web_search ×3')
  })

  it('returns empty for no tools', () => {
    expect(summarizeToolNames([])).toBe('')
  })

  it('groups computer tools', () => {
    expect(summarizeToolNames(['computer_state', 'computer_click'])).toBe(
      'computer ×2'
    )
  })
})

describe('formatKeyChord', () => {
  it('renders macOS modifier glyphs', () => {
    expect(formatKeyChord('cmd+s')).toBe('⌘S')
    expect(formatKeyChord('cmd+shift+p')).toBe('⌘⇧P')
    expect(formatKeyChord('ctrl+option+command+x')).toBe('⌃⌥⌘X')
  })

  it('title-cases named keys and arrows', () => {
    expect(formatKeyChord('esc')).toBe('Escape')
    expect(formatKeyChord('cmd+down')).toBe('⌘↓')
    expect(formatKeyChord('shift+tab')).toBe('⇧Tab')
  })
})

describe('computerToolSummary', () => {
  it('summarizes state reads with an optional screenshot hint', () => {
    expect(computerToolSummary('computer_state', { app: 'Finder' })).toBe(
      'Read Finder'
    )
    expect(
      computerToolSummary('computer_state', { app: 'Finder', screenshot: true })
    ).toBe('Read Finder · screenshot')
  })

  it('uses the element id, upgraded to the AX label from details', () => {
    expect(
      computerToolSummary('computer_click', { app: 'Finder', element: 12 })
    ).toBe('Clicked element 12 in Finder')
    expect(
      computerToolSummary(
        'computer_click',
        { app: 'Finder', element: 12 },
        { element: { label: 'Save' } }
      )
    ).toBe('Clicked "Save" in Finder')
  })

  it('summarizes value, typing, key, scroll, action and screenshot tools', () => {
    expect(
      computerToolSummary('computer_set_value', { app: 'TextEdit' })
    ).toBe('Set value in TextEdit')
    expect(
      computerToolSummary('computer_type', { app: 'TextEdit', text: 'hello world!' })
    ).toBe('Typed 12 characters in TextEdit')
    expect(
      computerToolSummary('computer_key', { app: 'Xcode', key: 'cmd+s' })
    ).toBe('Pressed ⌘S in Xcode')
    expect(
      computerToolSummary('computer_scroll', { app: 'Safari', direction: 'down' })
    ).toBe('Scrolled down in Safari')
    expect(computerToolSummary('computer_drag', { app: 'Safari' })).toBe(
      'Dragged in Safari'
    )
    expect(
      computerToolSummary('computer_action', { app: 'Finder', action: 'showMenu' })
    ).toBe('showMenu in Finder')
    expect(computerToolSummary('computer_screenshot', { app: 'Safari' })).toBe(
      'Screenshot of Safari'
    )
    expect(computerToolSummary('computer_apps', {})).toBe('Listed apps')
  })

  it('renders the confirm outcome', () => {
    expect(computerToolSummary('computer_confirm', {})).toBe('Asked for approval')
    expect(
      computerToolSummary('computer_confirm', {}, { approved: true })
    ).toBe('Approved')
    expect(
      computerToolSummary('computer_confirm', {}, { approved: false })
    ).toBe('Declined')
  })
})

describe('summarizeToolRuns', () => {
  const run = (name: string, args: Record<string, unknown> = {}, status = 'done') => ({
    name,
    args,
    status
  })

  it('joins categories in first-occurrence order', () => {
    expect(
      summarizeToolRuns([run('edit'), run('bash'), run('read'), run('read')]).text
    ).toBe('Edited a file, ran a command, read 2 files')
    expect(
      summarizeToolRuns([
        run('read'),
        run('edit'),
        run('edit'),
        run('bash'),
        run('bash'),
        run('bash')
      ]).text
    ).toBe('Read a file, edited 2 files, ran 3 commands')
  })

  it('uses singular phrasing for one-offs', () => {
    expect(summarizeToolRuns([run('write'), run('bash')]).text).toBe(
      'Created a file, ran a command'
    )
  })

  it('counts searches and browser/computer actions', () => {
    expect(summarizeToolRuns([run('grep'), run('glob')]).text).toBe('Searched 2 times')
    expect(
      summarizeToolRuns([run('browser_open'), run('browser_click')]).text
    ).toBe('Used the browser (2 actions)')
    expect(summarizeToolRuns([run('browser_open')]).text).toBe('Used the browser')
  })

  it('falls back to other tools', () => {
    expect(summarizeToolRuns([run('web_search'), run('mcp_thing')]).text).toBe(
      'Used 2 other tools'
    )
  })

  it('counts changed edit lines and written lines into a diff stat', () => {
    // The shared "a" is anchoring context, not a change.
    const s = summarizeToolRuns([
      run('edit', { oldText: 'a\nb', newText: 'a\nc\nd' }),
      run('write', { content: 'x\ny' })
    ])
    expect(s.diff).toEqual({ added: 4, removed: 1 })
  })

  it('supports the edits[] arg shape', () => {
    const s = summarizeToolRuns([
      run('edit', { edits: [{ oldText: 'a', newText: 'a\nb' }, { newText: 'c' }] })
    ])
    expect(s.diff).toEqual({ added: 2, removed: 0 })
  })

  it('omits the diff when no edits or writes ran', () => {
    expect(summarizeToolRuns([run('read'), run('bash')]).diff).toBeUndefined()
  })

  it('reports failures and in-flight runs', () => {
    const s = summarizeToolRuns([
      run('read'),
      run('bash', {}, 'error'),
      run('edit', {}, 'running')
    ])
    expect(s.failed).toBe(1)
    expect(s.running).toBe(1)
  })
})

describe('computerGroupApp', () => {
  it('names the shared app when every run is computer_*', () => {
    expect(
      computerGroupApp([
        { name: 'computer_state', args: { app: 'Finder' } },
        { name: 'computer_click', args: { app: 'Finder', element: 3 } }
      ])
    ).toBe('Finder')
  })

  it('returns null for mixed tools or mixed apps', () => {
    expect(
      computerGroupApp([
        { name: 'computer_state', args: { app: 'Finder' } },
        { name: 'browser_open', args: {} }
      ])
    ).toBeNull()
    expect(
      computerGroupApp([
        { name: 'computer_state', args: { app: 'Finder' } },
        { name: 'computer_state', args: { app: 'Safari' } }
      ])
    ).toBeNull()
    expect(computerGroupApp([])).toBeNull()
  })
})

describe('toolCategory word matching', () => {
  it('keeps show_image out of the shell tools', () => {
    expect(toolCategory('show_image')).toBe('image')
    expect(toolCategory('shell')).toBe('run')
    expect(toolCategory('sh')).toBe('run')
    expect(toolCategory('run_command')).toBe('run')
    expect(toolCategory('execute_command')).toBe('run')
    expect(toolCategory('runtime_info')).toBe('other')
    expect(summarizeToolRuns([{ name: 'show_image', args: {}, status: 'done' }]).text).toBe('Showed an image')
  })
})
