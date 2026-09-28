import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The pi extension registers computer_* tools only when the main process
 * injects PI_DESKTOP_COMPUTER_USE=1 (helper present + setting enabled).
 * computer_confirm must be answered via ctx.ui.confirm, not the bridge.
 */

interface RegisteredTool {
  name: string
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (u: unknown) => void,
    ctx: { ui: { confirm(t: string, m: string): Promise<boolean> } }
  ) => Promise<{ content: { type: string; text?: string }[]; details: Record<string, unknown> }>
}

async function loadExtension(env: Record<string, string | undefined>) {
  vi.resetModules()
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  try {
    const mod = (await import(
      // @ts-expect-error plain-JS extension ships untyped on purpose
      '../resources/pi-extension/pi-desktop-browser/index.js'
    )) as { default: (pi: { registerTool(t: RegisteredTool): void }) => void }
    return mod.default
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

function fakePi() {
  const tools: RegisteredTool[] = []
  return { tools, pi: { registerTool: (t: RegisteredTool) => tools.push(t) } }
}

const BASE_ENV = {
  PI_DESKTOP_BRIDGE_URL: 'http://127.0.0.1:1',
  PI_DESKTOP_BRIDGE_TOKEN: 'deadbeef'
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pi extension computer tools', () => {
  it('registers no computer_* tools without the env flag', async () => {
    const factory = await loadExtension({
      ...BASE_ENV,
      PI_DESKTOP_COMPUTER_USE: undefined
    })
    const { tools, pi } = fakePi()
    factory(pi)
    expect(tools.filter((t) => t.name.startsWith('computer_'))).toEqual([])
    expect(tools.length).toBeGreaterThan(0) // browser tools still register
  })

  it('registers all computer_* tools with the env flag', async () => {
    const factory = await loadExtension({
      ...BASE_ENV,
      PI_DESKTOP_COMPUTER_USE: '1'
    })
    const { tools, pi } = fakePi()
    factory(pi)
    const names = tools.map((t) => t.name)
    for (const name of [
      'computer_apps',
      'computer_state',
      'computer_click',
      'computer_set_value',
      'computer_type',
      'computer_key',
      'computer_scroll',
      'computer_drag',
      'computer_action',
      'computer_screenshot',
      'computer_confirm'
    ]) {
      expect(names).toContain(name)
    }
  })

  it('answers computer_confirm through ctx.ui.confirm', async () => {
    const factory = await loadExtension({
      ...BASE_ENV,
      PI_DESKTOP_COMPUTER_USE: '1'
    })
    const { tools, pi } = fakePi()
    factory(pi)
    const confirm = tools.find((t) => t.name === 'computer_confirm')
    expect(confirm).toBeDefined()
    const abort = new AbortController()
    const yes = await confirm!.execute(
      'id',
      { summary: 'Delete the file' },
      abort.signal,
      () => {},
      { ui: { confirm: async () => true } }
    )
    expect(yes.details['approved']).toBe(true)
    expect(yes.content[0]?.text).toMatch(/Approved/)
    const no = await confirm!.execute(
      'id',
      { summary: 'Send it' },
      abort.signal,
      () => {},
      { ui: { confirm: async () => false } }
    )
    expect(no.details['approved']).toBe(false)
    expect(no.content[0]?.text).toMatch(/Not approved/)
  })
})
