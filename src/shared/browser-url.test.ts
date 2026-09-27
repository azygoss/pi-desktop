import { describe, expect, it } from 'vitest'

import { isAllowedBrowserUrl, normalizeBrowserUrl } from './browser-url'

describe('normalizeBrowserUrl', () => {
  it('passes http(s) URLs through', () => {
    expect(normalizeBrowserUrl('https://example.com/x')).toBe('https://example.com/x')
    expect(normalizeBrowserUrl('http://localhost:5173/')).toBe('http://localhost:5173/')
  })

  it('maps localhost shorthand to http', () => {
    expect(normalizeBrowserUrl('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeBrowserUrl('127.0.0.1:8080/path')).toBe('http://127.0.0.1:8080/path')
  })

  it('maps bare domains to https', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com')
    expect(normalizeBrowserUrl('pi.dev/docs')).toBe('https://pi.dev/docs')
  })

  it('turns everything else into a search', () => {
    expect(normalizeBrowserUrl('hello world')).toBe(
      'https://duckduckgo.com/?q=hello%20world'
    )
  })

  it('rejects non-web schemes', () => {
    expect(normalizeBrowserUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeBrowserUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeBrowserUrl('pi-internal://x')).toBeNull()
    expect(normalizeBrowserUrl('')).toBeNull()
  })
})

describe('isAllowedBrowserUrl', () => {
  it('only allows http and https', () => {
    expect(isAllowedBrowserUrl('https://a.dev')).toBe(true)
    expect(isAllowedBrowserUrl('http://localhost')).toBe(true)
    expect(isAllowedBrowserUrl('file:///x')).toBe(false)
    expect(isAllowedBrowserUrl('not a url')).toBe(false)
  })
})
