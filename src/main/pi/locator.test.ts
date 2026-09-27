import { describe, expect, it } from 'vitest'

import {
  mergePathEntries,
  parsePiVersion,
  resolvePiRuntime,
  type LocatorDeps
} from './locator'

describe('parsePiVersion', () => {
  it('parses a bare version', () => {
    expect(parsePiVersion('0.85.1')).toBe('0.85.1')
  })

  it('parses a version embedded in noise', () => {
    expect(parsePiVersion('pi version 0.85.1\n')).toBe('0.85.1')
  })

  it('parses pre-release suffixes', () => {
    expect(parsePiVersion('1.2.3-beta.4')).toBe('1.2.3-beta.4')
  })

  it('returns null when no version is present', () => {
    expect(parsePiVersion('no version here')).toBeNull()
  })
})

describe('mergePathEntries', () => {
  it('merges sources and common dirs, deduped, first wins', () => {
    const merged = mergePathEntries(
      'darwin',
      '/home/example',
      '/shell/a:/shell/b',
      '/shell/b:/env/c'
    )
    const dirs = merged.split(':')
    expect(dirs[0]).toBe('/shell/a')
    expect(dirs[1]).toBe('/shell/b')
    expect(dirs[2]).toBe('/env/c')
    expect(dirs).toContain('/opt/homebrew/bin')
    expect(dirs).toContain('/usr/local/bin')
    expect(dirs.filter((d) => d === '/shell/b')).toHaveLength(1)
  })

  it('expands ~ against homeDir for common dirs', () => {
    const merged = mergePathEntries('darwin', '/home/example', undefined)
    const dirs = merged.split(':')
    expect(dirs).toContain('/home/example/.bun/bin')
    expect(dirs).toContain('/home/example/.volta/bin')
  })

  it('uses ; separator on win32', () => {
    const merged = mergePathEntries('win32', 'C:/Users/example', 'C:\\a;C:\\b')
    expect(merged.split(';')).toContain('C:\\a')
    expect(merged.split(';')).toContain('C:\\b')
    expect(merged).not.toContain(':C:')
  })
})

function makeDeps(overrides: Partial<LocatorDeps> = {}): LocatorDeps {
  return {
    platform: 'darwin',
    env: { PATH: '/env/bin' },
    homeDir: '/home/example',
    shell: '/bin/zsh',
    isExecutable: async () => false,
    readVersion: async () => null,
    readLoginShellPath: async () => '/shell/bin',
    resolveBundledCli: async () => null,
    ...overrides
  }
}

describe('resolvePiRuntime', () => {
  it('returns the custom runtime when customPath is valid', async () => {
    const deps = makeDeps({
      readVersion: async (command) => (command === '/custom/pi' ? '0.85.1' : null)
    })
    const runtime = await resolvePiRuntime({ customPath: '/custom/pi', deps })
    expect(runtime).toMatchObject({
      kind: 'custom',
      command: '/custom/pi',
      args: [],
      version: '0.85.1'
    })
    expect(runtime.env['PATH']).toContain('/shell/bin')
    expect(runtime.env['PATH']).toContain('/env/bin')
  })

  it('falls back to installed pi when custom path is invalid', async () => {
    const deps = makeDeps({
      isExecutable: async (p) => p === '/shell/bin/pi',
      readVersion: async (command) => (command === '/shell/bin/pi' ? 'pi 0.85.1' : null)
    })
    const runtime = await resolvePiRuntime({ customPath: '/missing/pi', deps })
    expect(runtime).toMatchObject({
      kind: 'installed',
      command: '/shell/bin/pi',
      version: '0.85.1'
    })
  })

  it('finds installed pi across merged PATH dirs', async () => {
    const deps = makeDeps({
      isExecutable: async (p) => p === '/opt/homebrew/bin/pi',
      readVersion: async () => '0.85.1'
    })
    const runtime = await resolvePiRuntime({ deps })
    expect(runtime.kind).toBe('installed')
    expect(runtime.command).toBe('/opt/homebrew/bin/pi')
  })

  it('uses the bundled runtime when nothing is installed', async () => {
    const deps = makeDeps({
      resolveBundledCli: async () => ({
        cliPath: '/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
        version: '0.85.1'
      }),
      readVersion: async () => '0.85.1'
    })
    const runtime = await resolvePiRuntime({ deps })
    expect(runtime.kind).toBe('bundled')
    expect(runtime.command).toBe(process.execPath)
    expect(runtime.args).toEqual([
      '/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'
    ])
    expect(runtime.env['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(runtime.env['PATH']).toContain('/shell/bin')
  })

  it('prefers bundled over installed when preferBundled is set', async () => {
    const deps = makeDeps({
      isExecutable: async (p) => p === '/shell/bin/pi',
      readVersion: async () => '0.85.1',
      resolveBundledCli: async () => ({ cliPath: '/bundled/cli.js', version: '0.85.1' })
    })
    const runtime = await resolvePiRuntime({ deps, preferBundled: true })
    expect(runtime.kind).toBe('bundled')
    expect(runtime.args).toEqual(['/bundled/cli.js'])
  })

  it('keeps the bundled package version when --version fails', async () => {
    const deps = makeDeps({
      resolveBundledCli: async () => ({ cliPath: '/bundled/cli.js', version: '0.85.1' }),
      readVersion: async () => null
    })
    const runtime = await resolvePiRuntime({ deps })
    expect(runtime).toMatchObject({ kind: 'bundled', version: '0.85.1' })
  })

  it('probes the bundled cli with ELECTRON_RUN_AS_NODE so it does not spawn an app', async () => {
    const probedEnvs: (Record<string, string> | undefined)[] = []
    const deps = makeDeps({
      resolveBundledCli: async () => ({ cliPath: '/bundled/cli.js', version: '0.85.1' }),
      readVersion: async (_command, _args, env) => {
        probedEnvs.push(env)
        return '0.85.1'
      }
    })
    const runtime = await resolvePiRuntime({ deps })
    expect(runtime.kind).toBe('bundled')
    expect(probedEnvs).toHaveLength(1)
    expect(probedEnvs[0]?.['ELECTRON_RUN_AS_NODE']).toBe('1')
  })

  it('probes installed pi with the merged PATH', async () => {
    const probedEnvs: (Record<string, string> | undefined)[] = []
    const deps = makeDeps({
      isExecutable: async (p) => p === '/shell/bin/pi',
      readVersion: async (_command, _args, env) => {
        probedEnvs.push(env)
        return '0.85.1'
      }
    })
    const runtime = await resolvePiRuntime({ deps })
    expect(runtime.kind).toBe('installed')
    expect(probedEnvs[0]?.['PATH']).toContain('/shell/bin')
  })

  it('restricts resolution to the configured runtime mode', async () => {
    const deps = makeDeps({
      isExecutable: async (p) => p === '/shell/bin/pi',
      resolveBundledCli: async () => ({ cliPath: '/bundled/cli.js', version: '0.85.1' }),
      readVersion: async () => '0.85.1'
    })
    const installed = await resolvePiRuntime({ deps, mode: 'installed' })
    expect(installed.kind).toBe('installed')
    const bundled = await resolvePiRuntime({ deps, mode: 'bundled' })
    expect(bundled.kind).toBe('bundled')
  })

  it('throws when nothing resolves', async () => {
    await expect(resolvePiRuntime({ deps: makeDeps() })).rejects.toThrow('No pi runtime found')
  })
})
