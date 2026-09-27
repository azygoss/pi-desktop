import { describe, expect, it } from 'vitest'

import { summarizeToolNames } from './tool-summary'

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
})
