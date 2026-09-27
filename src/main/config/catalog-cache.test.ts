import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getCatalogCache, resetCatalogCache, updateCatalogCache } from './catalog-cache'

let userData: string

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'pi-desktop-catalog-'))
  process.env['PI_DESKTOP_USER_DATA_DIR'] = userData
  resetCatalogCache()
})

afterEach(async () => {
  delete process.env['PI_DESKTOP_USER_DATA_DIR']
  resetCatalogCache()
  await rm(userData, { recursive: true, force: true })
})

const MODEL = {
  id: 'synthetic-sonnet',
  provider: 'anthropic',
  name: 'Synthetic Sonnet',
  api: 'anthropic-messages',
  baseUrl: 'https://example.invalid',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 64000
}

async function flushWrite(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 700))
}

describe('catalog cache', () => {
  it('returns null when no cache file exists', async () => {
    expect(await getCatalogCache()).toBeNull()
  })

  it('persists models/commands/levels and reloads them', async () => {
    updateCatalogCache({
      models: [MODEL],
      commands: [{ name: 'review-code', description: 'x', source: 'prompt' }],
      thinkingLevels: ['off', 'high'],
      model: MODEL,
      thinkingLevel: 'high',
      lastStartupMs: 1234
    })
    await flushWrite()

    resetCatalogCache()
    const loaded = await getCatalogCache()
    expect(loaded?.models).toHaveLength(1)
    expect(loaded?.models[0]?.id).toBe('synthetic-sonnet')
    expect(loaded?.commands[0]?.name).toBe('review-code')
    expect(loaded?.thinkingLevels).toEqual(['off', 'high'])
    expect(loaded?.model?.id).toBe('synthetic-sonnet')
    expect(loaded?.thinkingLevel).toBe('high')
    expect(loaded?.lastStartupMs).toBe(1234)
  })

  it('merges partial updates without dropping fields', async () => {
    updateCatalogCache({ models: [MODEL], model: MODEL })
    await flushWrite()
    updateCatalogCache({ lastStartupMs: 500 })
    await flushWrite()

    resetCatalogCache()
    const loaded = await getCatalogCache()
    expect(loaded?.models).toHaveLength(1)
    expect(loaded?.lastStartupMs).toBe(500)
  })

  it('falls back to null on corrupt JSON', async () => {
    await writeFile(join(userData, 'catalog-cache.json'), '{{{ not json')
    resetCatalogCache()
    expect(await getCatalogCache()).toBeNull()
  })

  it('drops malformed entries on load', async () => {
    await writeFile(
      join(userData, 'catalog-cache.json'),
      JSON.stringify({
        models: [MODEL, { id: 42 }, 'junk'],
        commands: [{ name: 'ok' }, { nope: true }],
        thinkingLevels: ['high', 7, null],
        model: { bogus: true },
        thinkingLevel: 'HIGH!'
      })
    )
    resetCatalogCache()
    const loaded = await getCatalogCache()
    expect(loaded?.models).toHaveLength(1)
    expect(loaded?.commands).toHaveLength(1)
    expect(loaded?.thinkingLevels).toEqual(['high'])
    expect(loaded?.model).toBeNull()
    expect(loaded?.thinkingLevel).toBeNull()
  })
})
