import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rename, writeFile } from 'node:fs/promises'
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
    const wt = await createWorktree(repo, base, undefined, 'calm-reef-07')
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

  it('names the new branch and where it starts, or checks out an existing one', async () => {
    const repo = await repoWithCommit()
    const run = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]).toString()
    run('branch', 'release')
    await writeFile(join(repo, 'a.txt'), 'two\n')
    run('commit', '-qam', 'second')
    const base = await realpath(await mkdtemp(join(tmpdir(), 'pi-wt-base-')))

    const named = await createWorktree(repo, base, { kind: 'new', branch: 'feature/login', from: 'release' })
    expect(named).toMatchObject({ branch: 'feature/login', cwd: join(base, basename(repo), 'login') })
    expect(execFileSync('git', ['-C', named.cwd, 'log', '-1', '--format=%s']).toString().trim()).toBe('init')

    const existing = await createWorktree(repo, base, { kind: 'existing', branch: 'release' })
    expect(existing).toMatchObject({ branch: 'release', cwd: join(base, basename(repo), 'release') })
    // A branch can be checked out in one worktree only: git says so.
    await expect(createWorktree(repo, base, { kind: 'existing', branch: 'release' })).rejects.toThrow()
    await expect(createWorktree(repo, base, { kind: 'new', branch: 'feature/login' })).rejects.toThrow(/already exists/)
    await expect(createWorktree(repo, base, { kind: 'new', branch: 'bad name' })).rejects.toThrow(
      /can't contain spaces/
    )
    await expect(createWorktree(repo, base, { kind: 'new', branch: '-x' })).rejects.toThrow(
      /can't start with '-'/
    )

    // A merged branch goes with its worktree; an unmerged one stays.
    expect((await removeWorktree(existing.cwd, base, false, true)).message).toMatch(
      /^Worktree and branch release removed \(it was at [0-9a-f]+: git branch release [0-9a-f]+ brings it back\)$/
    )
    await writeFile(join(named.cwd, 'b.txt'), 'new\n')
    execFileSync('git', ['-C', named.cwd, 'add', '-A'])
    execFileSync('git', ['-C', named.cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-qm', 'work'])
    expect((await removeWorktree(named.cwd, base, false, true)).message).toContain('kept')
    expect(run('branch', '--list', 'feature/login').trim()).toBe('feature/login')
  })

  it('puts a forced removal in the trash instead of deleting it', async () => {
    const repo = await repoWithCommit()
    const base = await realpath(await mkdtemp(join(tmpdir(), 'pi-wt-base-')))
    const bin = await realpath(await mkdtemp(join(tmpdir(), 'pi-wt-trash-')))
    const wt = await createWorktree(repo, base)
    await writeFile(join(wt.cwd, 'draft.txt'), 'unsaved work\n')
    const trashed: string[] = []
    const result = await removeWorktree(wt.cwd, base, true, false, async (path) => {
      trashed.push(path)
      await rename(path, join(bin, 'wt'))
    })
    expect(result.ok).toBe(true)
    expect(trashed).toEqual([wt.cwd])
    expect(existsSync(join(bin, 'wt', 'draft.txt'))).toBe(true)
    expect(execFileSync('git', ['-C', repo, 'worktree', 'list']).toString()).not.toContain(wt.cwd)
  })

  it('builds readable slugs', () => {
    expect(randomSlug(Buffer.from([0, 1, 7]))).toBe('amber-brisk-07')
  })
})
