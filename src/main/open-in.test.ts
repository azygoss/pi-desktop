import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { clearOpenTargetCache, listOpenTargets } from './open-in'

describe('listOpenTargets', () => {
  beforeEach(() => clearOpenTargetCache())

  it('lists only the apps that exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-open-in-'))
    await mkdir(join(dir, 'Zed.app'))
    await mkdir(join(dir, 'Terminal.app'))
    const targets = await listOpenTargets('darwin', [dir])
    expect(targets.map((t) => t.id)).toEqual(['zed', 'terminal'])
  })

  it('offers nothing off macOS', async () => {
    expect(await listOpenTargets('linux', [])).toEqual([])
  })
})
