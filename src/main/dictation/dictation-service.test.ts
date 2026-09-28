import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DictationService, type DictationEvent } from './dictation-service'

const FIXTURE = join(import.meta.dirname, '__fixtures__', 'fake-dictation.mjs')

function makeService(env: Record<string, string> = {}): DictationService {
  return new DictationService({
    helperPath: FIXTURE,
    spawn: (cmd, args) =>
      spawn(process.execPath, [cmd, ...args], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env, ...env }
      }) as ChildProcess
  })
}

function collect(service: DictationService): DictationEvent[] {
  const events: DictationEvent[] = []
  service.onEvent((e) => events.push(e))
  return events
}

function waitFor(events: DictationEvent[], name: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + timeoutMs
    const check = () => {
      if (events.some((e) => e.event === name)) {
        resolvePromise()
      } else if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${name}; saw ${events.map((e) => e.event)}`))
      } else {
        setTimeout(check, 20)
      }
    }
    check()
  })
}

describe('DictationService', () => {
  it('reports availability via the helper override', () => {
    const service = makeService()
    expect(service.available()).toBe(true)
    const missing = new DictationService({ helperPath: '/nonexistent/helper' })
    expect(missing.available()).toBe(false)
  })

  it('answers permissions and locales', async () => {
    const service = makeService()
    expect(await service.call('permissions')).toEqual({
      microphone: 'authorized',
      speech: 'authorized'
    })
    expect(await service.call('locales')).toEqual({ locales: ['en-US', 'tr-TR', 'de-DE'] })
    service.dispose()
  })

  it('streams partial events then a final on stop', async () => {
    const service = makeService()
    const events = collect(service)
    await service.start({})
    expect(service.recording).toBe(true)
    await waitFor(events, 'partial')
    await service.stop()
    await waitFor(events, 'stopped')
    const final = events.find((e) => e.event === 'final')
    expect(final?.text).toBe('hello pi desktop')
    expect(events.filter((e) => e.event === 'level').length).toBeGreaterThan(0)
    service.dispose()
  })

  it('cancel emits cancelled and no final', async () => {
    const service = makeService()
    const events = collect(service)
    await service.start({})
    await service.cancel()
    await waitFor(events, 'cancelled')
    expect(service.recording).toBe(false)
    expect(events.some((e) => e.event === 'final')).toBe(false)
    service.dispose()
  })

  it('surfaces a helper crash as an error event and rejects the start', async () => {
    const service = makeService({ PI_FAKE_DICTATION_CRASH: '1' })
    const events = collect(service)
    await expect(service.start({})).rejects.toThrow()
    await waitFor(events, 'error')
    service.dispose()
  })
})
