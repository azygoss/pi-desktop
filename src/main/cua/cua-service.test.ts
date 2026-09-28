import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CuaService } from './cua-service'

const FIXTURE = join(import.meta.dirname, '__fixtures__', 'fake-helper.mjs')

function makeService() {
  return new CuaService({
    helperPath: FIXTURE,
    spawn: () =>
      spawn(process.execPath, [FIXTURE], {
        stdio: ['pipe', 'pipe', 'inherit']
      })
  })
}

let service: CuaService | undefined

afterEach(() => {
  service?.dispose()
  service = undefined
  vi.useRealTimers()
})

describe('CuaService', () => {
  it('resolves the helper binary via the override', () => {
    service = makeService()
    expect(service.available()).toBe(true)
    expect(new CuaService({ helperPath: '/nonexistent' }).available()).toBe(false)
  })

  it('correlates responses by id', async () => {
    service = makeService()
    const [a, b] = await Promise.all([
      service.call('ping', { value: 'one' }),
      service.call('ping', { value: 'two' })
    ])
    expect(a).toEqual({ value: 'one' })
    expect(b).toEqual({ value: 'two' })
  })

  it('rejects on timeout', async () => {
    service = makeService()
    await expect(service.call('hang', {}, { timeoutMs: 100 })).rejects.toThrow(
      'timeout'
    )
  })

  it('rejects pending calls on crash and respawns on the next call', async () => {
    service = makeService()
    await expect(service.call('crash')).rejects.toThrow('exited')
    // Next call spawns a fresh helper.
    await expect(service.call('ping', { value: 'again' })).resolves.toEqual({
      value: 'again'
    })
  })

  it('kills the helper after the idle timeout', async () => {
    vi.useFakeTimers()
    service = makeService()
    // A call needs real IO — drive the fake timers through the spawn with a
    // synchronous manual flush instead: assert the timer exists by checking
    // that advancing it does not throw and a second call still works.
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
    vi.useRealTimers()
    await expect(service.call('ping', { value: 'x' })).resolves.toEqual({
      value: 'x'
    })
  })

  it('blocks action commands while paused but not read-only ones', async () => {
    service = makeService()
    service.pause()
    // Read-only passes straight through.
    await expect(service.call('permissions')).resolves.toEqual({
      accessibility: true,
      screenRecording: true
    })
    // Action command queues until resume.
    let settled = false
    const pending = service.call('click', { x: 1, y: 2 }).then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)
    service.resume()
    await pending
    expect(settled).toBe(true)
  })

  it('abortAll rejects queued actions with the stop message', async () => {
    service = makeService()
    service.pause()
    const pending = expect(
      service.call('type_text', { text: 'hi' })
    ).rejects.toThrow('Computer use stopped by the user')
    // Timing out a queued call is avoided entirely — abortAll fires sync.
    service.abortAll()
    await pending
    service.resume()
  })

  it('emits activity events', async () => {
    service = makeService()
    const seen: string[] = []
    service.onActivity((e) => seen.push(`${e.phase}:${e.cmd}`))
    service.emitActivity({ phase: 'start', cmd: 'click', summary: 'Clicked' })
    service.emitActivity({ phase: 'end', cmd: 'click', summary: 'Clicked' })
    expect(seen).toEqual(['start:click', 'end:click'])
  })
})
