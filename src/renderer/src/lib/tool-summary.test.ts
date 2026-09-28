import { describe, expect, it } from 'vitest'

import {
  computerGroupApp,
  computerToolSummary,
  formatKeyChord,
  summarizeToolNames
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
