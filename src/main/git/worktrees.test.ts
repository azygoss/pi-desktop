import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  createWorktree,
  isAppWorktree,
  randomSlug,
  removeWorktree,
  worktreeDisplayName
} from './worktrees'

async function repoWithCommit(): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'pi-wt-repo-')))
  const run = (...args: string[]) => execFileSync('git', ['-C', repo, ...args])
  run('init', '-q')
  run('config', 'user.email', 'test@example.invalid')
  run('config', 'user.name', 'Test')
  run('config', 'commit.gpgsign', 'false')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  run('add', '-A')
  run('commit', '-q', '-m', 'init')
  return repo
}

describe('worktrees', () => {
  it('creates an isolated checkout on a pi/ branch and removes it', async () => {
    const repo = await repoWithCommit()
    const base = await realpath(await mkdtemp(join(tmpdir(), 'pi-wt-base-')))
    const wt = await createWorktree(repo, base, 'calm-reef-07')
    expect(wt).toEqual({
      cwd: join(base, basename(repo), 'calm-reef-07'),
      branch: 'pi/calm-reef-07',
      repo
    })
    expect(existsSync(join(wt.cwd, 'a.txt'))).toBe(true)
    expect(isAppWorktree(wt.cwd, base)).toBe(true)
    expect(worktreeDisplayName(wt.cwd)).toBe(`${basename(repo)} · calm-reef-07`)

    // Uncommitted work blocks removal unless forced.
    await writeFile(join(wt.cwd, 'a.txt'), 'changed\n')
    expect((await removeWorktree(wt.cwd, base)).ok).toBe(false)
    expect((await removeWorktree(wt.cwd, base, true)).ok).toBe(true)
    expect(existsSync(wt.cwd)).toBe(false)
  })

  it('only removes worktrees under the app directory', async () => {
    const repo = await repoWithCommit()
    const base = await mkdtemp(join(tmpdir(), 'pi-wt-base-'))
    expect(isAppWorktree(repo, base)).toBe(false)
    expect(isAppWorktree(base, base)).toBe(false)
    await expect(removeWorktree(repo, base)).rejects.toThrow()
  })

  it('needs a repository with a commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-wt-none-'))
    await expect(createWorktree(dir, dir)).rejects.toThrow(/git repository/)
  })

  it('builds readable slugs', () => {
    expect(randomSlug(Buffer.from([0, 1, 7]))).toBe('amber-brisk-07')
  })
})
