import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listDirs } from './list-dirs'

describe('listDirs', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'pi-desktop-dirs-')))
    await mkdir(join(root, 'projects', 'app', '.git'), { recursive: true })
    await mkdir(join(root, 'projects', '.hidden'), { recursive: true })
    await mkdir(join(root, 'agent', 'sessions'), { recursive: true })
    await writeFile(join(root, 'projects', 'notes.txt'), 'x')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('lists visible sub-directories and flags a repository', async () => {
    const listing = await listDirs(join(root, 'projects'))
    expect(listing.dirs).toEqual(['app'])
    expect(listing.parent).toBe(root)
    expect((await listDirs(join(root, 'projects', 'app'))).repo).toBe(true)
  })

  it('refuses the forbidden root, however it is reached', async () => {
    const agent = join(root, 'agent')
    await expect(listDirs(agent, [agent])).rejects.toThrow('cannot be opened')
    await expect(listDirs(join(agent, 'sessions'), [agent])).rejects.toThrow('cannot be opened')
    // A symlink into it is the same folder.
    await symlink(agent, join(root, 'projects', 'link'))
    await expect(listDirs(join(root, 'projects', 'link'), [agent])).rejects.toThrow('cannot be opened')
    await expect(listDirs(join(root, 'projects', 'link', 'sessions'), [agent])).rejects.toThrow(
      'cannot be opened'
    )
  })

  it('rejects relative and non-string paths', async () => {
    await expect(listDirs('projects')).rejects.toThrow('Invalid path')
    await expect(listDirs(42)).rejects.toThrow('Invalid path')
  })
})
