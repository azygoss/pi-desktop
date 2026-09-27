import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const USER_DATA = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: () => USER_DATA.dir
  }
}))

const { DEFAULT_APP_SETTINGS, loadAppSettings, resetAppSettingsCache, updateAppSettings } =
  await import('./app-settings')

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-desktop-settings-'))
  USER_DATA.dir = dir
  resetAppSettingsCache()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('app settings', () => {
  it('returns defaults when the file is missing', async () => {
    expect(await loadAppSettings()).toEqual(DEFAULT_APP_SETTINGS)
  })

  it('falls back to defaults on malformed JSON', async () => {
    await writeFile(join(dir, 'settings.json'), '{ not json')
    expect(await loadAppSettings()).toEqual(DEFAULT_APP_SETTINGS)
  })

  it('sanitizes a partially invalid file', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        theme: 'neon',
        displayName: 42,
        piRuntime: { mode: 'warp', customPath: 7 },
        hiddenProjects: ['/ok', 5, null],
        sidebarCollapsed: 'yes'
      })
    )
    expect(await loadAppSettings()).toEqual({
      ...DEFAULT_APP_SETTINGS,
      hiddenProjects: ['/ok']
    })
  })

  it('persists updates and merges patches', async () => {
    await updateAppSettings({ theme: 'light', displayName: 'Alex' })
    await updateAppSettings({ hiddenProjects: ['/hidden/project'] })
    const settings = await loadAppSettings()
    expect(settings.theme).toBe('light')
    expect(settings.displayName).toBe('Alex')
    expect(settings.hiddenProjects).toEqual(['/hidden/project'])
    expect(settings.sidebarCollapsed).toBe(false)
  })

  it('persists added projects and collapsed state', async () => {
    await updateAppSettings({
      projects: [
        { cwd: '/Users/example/alpha', addedAt: '2024-01-01T00:00:00Z' },
        { cwd: 'relative/path', addedAt: '2024-01-01T00:00:00Z' },
        { cwd: '/Users/example/alpha', addedAt: '2024-02-01T00:00:00Z' },
        { cwd: '/Users/example/beta' }
      ],
      collapsedProjects: ['/Users/example/alpha']
    })
    const settings = await loadAppSettings()
    expect(settings.projects).toEqual([
      { cwd: '/Users/example/alpha', addedAt: '2024-01-01T00:00:00Z' },
      { cwd: '/Users/example/beta', addedAt: '' }
    ])
    expect(settings.collapsedProjects).toEqual(['/Users/example/alpha'])
  })

  it('ignores invalid patch fields instead of persisting them', async () => {
    const next = await updateAppSettings({
      theme: 'neon',
      piRuntime: { mode: 'warp', customPath: 3 },
      hiddenProjects: ['/a', 1]
    } as never)
    expect(next.theme).toBe('system')
    expect(next.piRuntime.mode).toBe('auto')
    expect(next.hiddenProjects).toEqual(['/a'])
  })
})
