import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'

import { clearFileListCache, listProjectFiles } from './file-list'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-desktop-files-'))
  clearFileListCache()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function git(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-C', dir, ...args], (e) => (e ? reject(e) : resolvePromise()))
  })
}

describe('listProjectFiles', () => {
  it('walks a non-git directory skipping noise dirs and hidden entries', async () => {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'a.ts'), '')
    await writeFile(join(dir, 'src', 'b test.ts'), '')
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'pkg', 'x.js'), '')
    await mkdir(join(dir, '.hidden'))
    await writeFile(join(dir, '.hidden', 'secret.txt'), '')
    await writeFile(join(dir, 'readme.md'), '')
    const files = await listProjectFiles(dir)
    expect(files).toEqual(['readme.md', 'src/a.ts', 'src/b test.ts'])
  })

  it('uses git ls-files inside a repo and honors .gitignore', async () => {
    await git(['init', '-b', 'main'])
    await writeFile(join(dir, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(dir, 'tracked.ts'), 'x')
    await writeFile(join(dir, 'ignored.txt'), 'x')
    await writeFile(join(dir, 'untracked.ts'), 'x')
    await git(['add', 'tracked.ts', '.gitignore'])
    const files = await listProjectFiles(dir)
    expect(files).toContain('tracked.ts')
    expect(files).toContain('untracked.ts')
    expect(files).toContain('.gitignore')
    expect(files).not.toContain('ignored.txt')
  })

  it('serves a second call from the cache', async () => {
    await writeFile(join(dir, 'one.txt'), '')
    const first = await listProjectFiles(dir)
    await writeFile(join(dir, 'two.txt'), '')
    const second = await listProjectFiles(dir)
    expect(second).toEqual(first)
  })
})
