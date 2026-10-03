import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { commitAll, discardFile, safeRepoPath } from './git-actions'

let repo = ''
const trashed: string[] = []
const trash = (path: string): Promise<void> => {
  trashed.push(path)
  return Promise.resolve()
}
const run = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'pi-git-actions-')))
  trashed.length = 0
  run('init', '-q')
  run('config', 'user.email', 'test@example.invalid')
  run('config', 'user.name', 'Test')
  run('config', 'commit.gpgsign', 'false')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  run('add', '-A')
  run('commit', '-q', '-m', 'init')
})

describe('safeRepoPath', () => {
  it('accepts repo-relative paths and rejects escapes', () => {
    expect(safeRepoPath('src/a.ts')).toBe(join('src', 'a.ts'))
    for (const bad of ['../x', '/etc/passwd', '-rf', '', 'a/../../b', 42]) {
      expect(() => safeRepoPath(bad)).toThrow()
    }
  })
})

describe('discardFile', () => {
  it('restores a modified tracked file from HEAD', async () => {
    await writeFile(join(repo, 'a.txt'), 'changed\n')
    const result = await discardFile(repo, 'a.txt', trash)
    expect(result.ok).toBe(true)
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('one\n')
    expect(trashed).toEqual([])
  })

  it('sends an untracked file to the trash instead of deleting it', async () => {
    await writeFile(join(repo, 'new.txt'), 'x')
    const result = await discardFile(repo, 'new.txt', trash)
    expect(result).toEqual({ ok: true, message: 'Moved to Trash' })
    expect(trashed).toEqual([join(repo, 'new.txt')])
    expect(existsSync(join(repo, 'new.txt'))).toBe(true)
  })

  it('unstages and trashes a file that was only added to the index', async () => {
    await writeFile(join(repo, 'staged.txt'), 'x')
    run('add', 'staged.txt')
    await discardFile(repo, 'staged.txt', trash)
    expect(trashed).toEqual([join(repo, 'staged.txt')])
    expect(run('status', '--porcelain')).toContain('?? staged.txt')
  })
})

describe('commitAll', () => {
  it('stages everything and commits', async () => {
    await writeFile(join(repo, 'b.txt'), 'two\n')
    const result = await commitAll(repo, 'Add b')
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/^Committed [0-9a-f]+$/)
    expect(run('status', '--porcelain')).toBe('')
    expect(run('log', '-1', '--format=%s').trim()).toBe('Add b')
  })

  it('reports a clean tree as a failure, and rejects an empty message', async () => {
    expect((await commitAll(repo, 'Nothing')).ok).toBe(false)
    await expect(commitAll(repo, '   ')).rejects.toThrow()
  })
})
