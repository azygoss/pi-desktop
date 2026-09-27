/**
 * URL handling for the in-app browser. Only http(s) pages are allowed;
 * anything else that looks like a search becomes a DuckDuckGo query.
 * `file:` and custom schemes are rejected (returned as null).
 */

const SEARCH_URL = 'https://duckduckgo.com/?q='

export function isAllowedBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i
const DOMAIN_LIKE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?(\/|$)/i

/**
 * Turn omnibox input into a navigable URL.
 * Returns null for explicit non-web schemes (file:, javascript:, …).
 */
export function normalizeBrowserUrl(input: string): string | null {
  const value = input.trim()
  if (!value) {
    return null
  }
  // localhost:3000 looks like a scheme to a naive regex — check it first.
  if (LOCAL_HOST.test(value)) {
    return `http://${value}`
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    // Explicit scheme — only http/https allowed.
    return isAllowedBrowserUrl(value) ? value : null
  }
  if (DOMAIN_LIKE.test(value)) {
    return `https://${value}`
  }
  return `${SEARCH_URL}${encodeURIComponent(value)}`
}
