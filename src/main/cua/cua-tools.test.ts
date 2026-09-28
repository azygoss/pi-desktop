import { describe, expect, it, vi } from 'vitest'

import type { CuaService } from './cua-service'
import { ComputerToolBridge } from './cua-tools'

type CallArgs = [cmd: string, args: Record<string, unknown>, opts?: unknown]

function makeBridge({
  enabled = true,
  permissions = { accessibility: true, screenRecording: true },
  impl = {}
}: {
  enabled?: boolean
  permissions?: { accessibility: boolean; screenRecording: boolean }
  impl?: Record<string, unknown>
} = {}) {
  const calls: CallArgs[] = []
  const service = {
    available: () => true,
    call: vi.fn(
      async (cmd: string, args: Record<string, unknown>, opts?: unknown) => {
        calls.push([cmd, args, opts])
        if (cmd === 'permissions') return permissions
        if (cmd === 'app_state') {
          return (
            impl['app_state'] ?? {
              app: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 1 },
              window: { title: 'Doc', x: 10, y: 10, width: 800, height: 600 },
              tree: '[1] button "Save" 10,10 80x24 {press}',
              diff: false
            }
          )
        }
        return impl[cmd] ?? { ok: true }
      }
    ),
    emitActivity: vi.fn()
  }
  const bridge = new ComputerToolBridge(service as unknown as CuaService, {
    isEnabled: async () => enabled
  })
  return { bridge, service, calls }
}

const SELF = 'io.github.azygoss.pidesktop'

describe('ComputerToolBridge', () => {
  it('errors when the setting is disabled', async () => {
    const { bridge } = makeBridge({ enabled: false })
    await expect(
      bridge.call('chat', 'computer_state', { app: 'Finder' })
    ).rejects.toThrow(/disabled in Pi Desktop settings/)
  })

  it('errors when accessibility permission is missing', async () => {
    const { bridge } = makeBridge({
      permissions: { accessibility: false, screenRecording: true }
    })
    await expect(
      bridge.call('chat', 'computer_state', { app: 'Finder' })
    ).rejects.toThrow(/Accessibility permission is required/)
    await expect(
      bridge.call('chat', 'computer_state', { app: 'Finder' })
    ).rejects.toThrow(/Privacy & Security/)
  })

  it('requires screen recording for screenshots', async () => {
    const { bridge } = makeBridge({
      permissions: { accessibility: true, screenRecording: false }
    })
    await expect(
      bridge.call('chat', 'computer_screenshot', { app: 'Finder' })
    ).rejects.toThrow(/Screen Recording permission/)
    // non-screenshot commands still pass the gate
    const r = await bridge.call('chat', 'computer_state', { app: 'Finder' })
    expect(r.text).toContain('App:')
  })

  it('rejects targeting Pi Desktop itself', async () => {
    const { bridge } = makeBridge()
    for (const id of [SELF, 'com.github.Electron', 'Pi Desktop', 'electron']) {
      await expect(
        bridge.call('chat', 'computer_state', { app: id })
      ).rejects.toThrow('Pi Desktop cannot control itself')
    }
  })

  it('passes self bundle ids to list_apps as exclusions', async () => {
    const { bridge, calls } = makeBridge({
      impl: { list_apps: [{ name: 'Finder', bundleId: 'com.apple.finder' }] }
    })
    const r = await bridge.call('chat', 'computer_apps', {})
    expect(r.text).toContain('Finder')
    const listCall = calls.find((c) => c[0] === 'list_apps')
    expect(listCall?.[1]).toEqual({
      excludeBundleIds: [SELF, 'com.github.Electron']
    })
  })

  it('formats computer_state with a header, tree, and screenshot caption', async () => {
    const { bridge } = makeBridge({
      impl: {
        app_state: {
          app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 2 },
          window: {
            title: 'Documents',
            x: 0,
            y: 0,
            width: 1200,
            height: 800
          },
          tree: '+ [3] button "Go" 5,5 40x20 {press}',
          diff: true,
          screenshot: {
            jpegBase64: 'QUJD',
            width: 1568,
            height: 1010,
            scale: 1.3
          }
        }
      }
    })
    const r = await bridge.call('chat', 'computer_state', {
      app: 'Finder',
      screenshot: true
    })
    expect(r.text).toContain(
      'App: Finder (com.apple.finder) — window "Documents" 1200x800'
    )
    expect(r.text).toContain('+ [3] button "Go"')
    expect(r.text).toContain('Screenshot attached')
    expect(r.image?.data).toBe('QUJD')
    expect(r.image?.mimeType).toBe('image/jpeg')
  })

  it('shows the no-changes marker for identical diffs', async () => {
    const { bridge } = makeBridge({
      impl: {
        app_state: {
          app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 2 },
          window: null,
          tree: '(no changes)',
          diff: true
        }
      }
    })
    const r = await bridge.call('chat', 'computer_state', { app: 'Finder' })
    expect(r.text).toContain('(no changes since last state)')
    expect(r.text).toContain('no window')
  })

  it('validates integer element ids and paired coordinates', async () => {
    const { bridge, calls } = makeBridge()
    await expect(
      bridge.call('chat', 'computer_click', { app: 'F', element: 1.5 })
    ).rejects.toThrow(/element.*integer/i)
    await expect(
      bridge.call('chat', 'computer_click', { app: 'F', x: 10 })
    ).rejects.toThrow(/y.*number/i)
    expect(calls.filter((c) => c[0] === 'click')).toHaveLength(0)
  })

  it('emits start/end activity summaries for every tool call', async () => {
    const { bridge, service } = makeBridge()
    await bridge.call('chat', 'computer_click', { app: 'Finder', element: 3 })
    const emit = service.emitActivity as ReturnType<typeof vi.fn>
    const events = emit.mock.calls.map(
      (c) => (c as [{ phase: string; summary: string }])[0]
    )
    expect(events.map((e) => e.phase)).toEqual(['start', 'end'])
    expect(events[0]?.summary).toMatch(/Clicked/)
  })

  it('caches a positive permissions result for 30s', async () => {
    const { bridge, calls } = makeBridge()
    await bridge.call('chat', 'computer_state', { app: 'Finder' })
    await bridge.call('chat', 'computer_state', { app: 'Finder' })
    await bridge.call('chat', 'computer_state', { app: 'Finder' })
    expect(calls.filter((c) => c[0] === 'permissions')).toHaveLength(1)
  })

  it('never caches a negative result — re-checks every call', async () => {
    const { bridge, calls } = makeBridge({
      permissions: { accessibility: false, screenRecording: true }
    })
    await expect(
      bridge.call('chat', 'computer_state', { app: 'Finder' })
    ).rejects.toThrow(/Accessibility permission/)
    await expect(
      bridge.call('chat', 'computer_state', { app: 'Finder' })
    ).rejects.toThrow(/Accessibility permission/)
    expect(calls.filter((c) => c[0] === 'permissions')).toHaveLength(2)
  })

  it('re-checks and retries once when a command reports a permission error', async () => {
    let stateCalls = 0
    const calls2: CallArgs[] = []
    const svc = {
      available: () => true,
      call: vi.fn(async (cmd: string) => {
        calls2.push([cmd, {}])
        if (cmd === 'permissions') {
          return { accessibility: true, screenRecording: true }
        }
        if (cmd === 'app_state') {
          stateCalls += 1
          if (stateCalls === 1) {
            throw new Error('accessibility permission not granted')
          }
          return {
            app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 2 },
            window: null,
            tree: '(no changes)',
            diff: true
          }
        }
        return {}
      }),
      emitActivity: vi.fn()
    }
    const fresh = new ComputerToolBridge(svc as unknown as CuaService, {
      isEnabled: async () => true
    })
    const r = await fresh.call('chat', 'computer_state', { app: 'Finder' })
    expect(r.text).toContain('(no changes since last state)')
    // permissions was re-checked (cache invalidated) and app_state retried
    expect(calls2.filter((c) => c[0] === 'permissions')).toHaveLength(2)
    expect(calls2.filter((c) => c[0] === 'app_state')).toHaveLength(2)
  })

  it('propagates the permission error when re-check still denies', async () => {
    const svc = {
      available: () => true,
      call: vi.fn(async (cmd: string) => {
        if (cmd === 'permissions') {
          return { accessibility: false, screenRecording: false }
        }
        throw new Error('accessibility permission not granted')
      }),
      emitActivity: vi.fn()
    }
    const fresh = new ComputerToolBridge(svc as unknown as CuaService, {
      isEnabled: async () => true
    })
    // Gate fails first (accessibility false) before any app_state call.
    await expect(
      fresh.call('chat', 'computer_state', { app: 'Finder' })
    ).rejects.toThrow(/Accessibility permission is required/)
  })

  it('rejects unknown computer tools', async () => {
    const { bridge } = makeBridge()
    await expect(
      bridge.call('chat', 'computer_bogus', {})
    ).rejects.toThrow(/unknown computer tool/)
  })
})
