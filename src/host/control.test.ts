import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { callControl, controlSocketPath, serveControl } from './control'

let root: string

beforeEach(async () => {
  // Short on purpose: socket paths are limited to ~104 bytes.
  root = await mkdtemp(join('/tmp', 'prc-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('control socket', () => {
  it('answers requests from the same user, and only known commands', async () => {
    const path = await controlSocketPath(root)
    expect(path).toBe(join(root, 'host.sock'))
    const stop = await serveControl(path, async (request) =>
      request.cmd === 'revoke' ? { removed: request.deviceId } : request.cmd
    )
    try {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(await callControl(path, { cmd: 'status' })).toBe('status')
      expect(await callControl(path, { cmd: 'revoke', deviceId: 'abc' })).toEqual({
        removed: 'abc'
      })
      await expect(
        callControl(path, { cmd: 'nope' } as unknown as { cmd: 'status' })
      ).rejects.toThrow('Unknown command')
    } finally {
      await stop()
    }
  })

  it('refuses to start next to a running host, but not over a dead socket file', async () => {
    const path = await controlSocketPath(root)
    const stop = await serveControl(path, async () => null)
    await expect(serveControl(path, async () => null)).rejects.toThrow('already running')
    await stop()
    // A socket file left behind by a crash does not block the next start.
    await writeFile(path, '')
    const again = await serveControl(path, async () => 'ok')
    expect(await callControl(path, { cmd: 'status' })).toBe('ok')
    await again()
  })

  it('reports a missing host plainly', async () => {
    await expect(callControl(join(root, 'host.sock'), { cmd: 'status' })).rejects.toThrow(
      'No pi-remote host is running'
    )
  })

  it('moves the socket out of a data directory with a long path', async () => {
    const deep = join(tmpdir(), 'x'.repeat(60), 'y'.repeat(60))
    const path = await controlSocketPath(deep)
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(100)
    expect(path).toMatch(/pi-remote-[0-9a-f]{12}\.sock$/)
    expect(await controlSocketPath(deep)).toBe(path)
    expect(await controlSocketPath(`${deep}2`)).not.toBe(path)
  })
})
