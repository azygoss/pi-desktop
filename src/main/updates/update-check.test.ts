import { describe, expect, it } from 'vitest'
import { checkForUpdate } from './update-check'

function respond(status: number, body: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    )) as typeof fetch
}

const RELEASE_URL = 'https://github.com/azygoss/pi-desktop/releases/tag/v0.4.0'

describe('checkForUpdate', () => {
  it('returns the release when the tag is newer than the app', async () => {
    const info = await checkForUpdate({
      currentVersion: '0.3.0',
      fetchImpl: respond(200, { tag_name: 'v0.4.0', html_url: RELEASE_URL })
    })
    expect(info).toEqual({ version: '0.4.0', url: RELEASE_URL })
  })

  it('is null when the release is not newer', async () => {
    for (const tag of ['v0.3.0', '0.2.9', 'v0.3.0-beta.1']) {
      const info = await checkForUpdate({
        currentVersion: '0.3.0',
        fetchImpl: respond(200, { tag_name: tag, html_url: RELEASE_URL })
      })
      expect(info, tag).toBeNull()
    }
  })

  it('is null on http errors (404 before any release exists)', async () => {
    const info = await checkForUpdate({
      currentVersion: '0.3.0',
      fetchImpl: respond(404, { message: 'Not Found' })
    })
    expect(info).toBeNull()
  })

  it('is null when the url escapes the repo prefix', async () => {
    const info = await checkForUpdate({
      currentVersion: '0.3.0',
      fetchImpl: respond(200, {
        tag_name: 'v9.9.9',
        html_url: 'https://example.com/evil'
      })
    })
    expect(info).toBeNull()
  })

  it('is null on malformed payloads and fetch failures', async () => {
    const cases: unknown[] = [
      { tag_name: 1, html_url: RELEASE_URL },
      { tag_name: 'v9.9.9' },
      'not json'
    ]
    for (const body of cases) {
      const info = await checkForUpdate({
        currentVersion: '0.3.0',
        fetchImpl: respond(200, body)
      })
      expect(info).toBeNull()
    }
    const info = await checkForUpdate({
      currentVersion: '0.3.0',
      fetchImpl: (() => Promise.reject(new Error('offline'))) as typeof fetch
    })
    expect(info).toBeNull()
  })
})
