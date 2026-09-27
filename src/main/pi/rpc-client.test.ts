import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { ExtensionUiRequest, PiEvent } from '../../shared/pi-types'
import type { PiRuntime } from './locator'
import { PiRpcClient } from './rpc-client'

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../test/fixtures/fake-pi.mjs'
)

const fakeRuntime: PiRuntime = {
  kind: 'installed',
  command: process.execPath,
  args: [fixturePath],
  env: {},
  version: '0.0.0-test'
}

function makeClient(): PiRpcClient {
  const client = new PiRpcClient({ runtime: fakeRuntime, cwd: process.cwd() })
  client.start()
  return client
}

function waitFor<T>(emitter: PiRpcClient, event: 'event' | 'exit'): Promise<T> {
  return new Promise((resolvePromise) => {
    emitter.once(event, (value: unknown) => resolvePromise(value as T))
  })
}

describe('PiRpcClient', () => {
  it('correlates request/response by id', async () => {
    const client = makeClient()
    try {
      const result = await client.request<{ ok: boolean }>({
        type: 'echo',
        data: { ok: true }
      })
      expect(result).toEqual({ ok: true })
    } finally {
      await client.stop()
    }
  })

  it('resolves concurrent requests to their own responses', async () => {
    const client = makeClient()
    try {
      const [a, b] = await Promise.all([
        client.request({ type: 'echo', data: 'a' }),
        client.request({ type: 'echo', data: 'b' })
      ])
      expect(a).toBe('a')
      expect(b).toBe('b')
    } finally {
      await client.stop()
    }
  })

  it('rejects on success:false responses', async () => {
    const client = makeClient()
    try {
      await expect(client.request({ type: 'fail' })).rejects.toThrow('synthetic failure')
    } finally {
      await client.stop()
    }
  })

  it('emits events for non-response lines', async () => {
    const client = makeClient()
    const events: PiEvent[] = []
    client.on('event', (e) => events.push(e))
    try {
      await client.request({ type: 'emit' })
      expect(events.map((e) => e.type)).toEqual(['agent_start', 'message_update'])
    } finally {
      await client.stop()
    }
  })

  it('also emits extension_ui_request as ui-request', async () => {
    const client = makeClient()
    const uiRequest = waitFor<ExtensionUiRequest>(client, 'event')
    const methods: string[] = []
    client.on('ui-request', (r) => methods.push(r.method))
    try {
      await client.request({ type: 'ui' })
      expect(methods).toEqual(['confirm'])
      expect((await uiRequest).type).toBe('extension_ui_request')
    } finally {
      await client.stop()
    }
  })

  it('emits protocol-error for malformed lines and keeps working', async () => {
    const client = makeClient()
    const protocolError = new Promise<string>((resolvePromise) => {
      client.once('protocol-error', (e) => resolvePromise(e.line))
    })
    try {
      await client.request({ type: 'malformed' })
      expect(await protocolError).toBe('this is not json {{{')
      const result = await client.request({ type: 'echo', data: 1 })
      expect(result).toBe(1)
    } finally {
      await client.stop()
    }
  })

  it('rejects pending requests when the process exits', async () => {
    const client = makeClient()
    const exitPromise = waitFor<{ code: number | null }>(client, 'exit')
    const pending = client.request({ type: 'hang' })
    await client.request({ type: 'echo', data: 'warmup' })
    client.sendRaw({ type: 'die' })
    await expect(pending).rejects.toThrow('exited')
    expect((await exitPromise).code).toBe(1)
  })

  it('rejects requests that time out', async () => {
    const client = makeClient()
    try {
      await expect(client.request({ type: 'hang' }, { timeoutMs: 50 })).rejects.toThrow(
        'timed out'
      )
    } finally {
      await client.stop()
    }
  })

  it('sends extension_ui_response for ui dialogs', async () => {
    const client = makeClient()
    const events: PiEvent[] = []
    client.on('event', (e) => events.push(e))
    try {
      await client.request({ type: 'ui' })
      client.respondUi({ id: 'ui-1', confirmed: true })
      await expect
        .poll(() => events.some((e) => (e as { type: string }).type === 'ui_response_seen'))
        .toBe(true)
    } finally {
      await client.stop()
    }
  })
})
