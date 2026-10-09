import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBranch, listBranches, switchBranch } from './branches'
import { createWorktree } from './worktrees'

async function repo(): Promise<{ dir: string; run: (...args: string[]) => string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-br-')))
  const run = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=T', ...args]).toString()
  run('init', '-q', '-b', 'main')
  await writeFile(join(dir, 'a.txt'), 'one\n')
  run('add', '-A')
  run('commit', '-qm', 'init')
  return { dir, run }
}

describe('branches', () => {
  it('lists branches, remote branches and worktrees', async () => {
    const { dir, run } = await repo()
    run('branch', 'feature')
    // A fake remote branch without a local one.
    run('update-ref', 'refs/remotes/origin/remote-only', 'HEAD')
    run('update-ref', 'refs/remotes/origin/main', 'HEAD')
    const base = await realpath(await mkdtemp(join(tmpdir(), 'pi-br-base-')))
    const wt = await createWorktree(dir, base, { kind: 'existing', branch: 'feature' })
    await writeFile(join(dir, 'a.txt'), 'changed\n')

    const info = await listBranches(dir, base)
    expect(info.root).toBe(dir)
    expect(info.current).toBe('main')
    expect(info.changes).toBe(1)
    expect(info.branches.map((b) => [b.name, b.current, b.worktree ?? null])).toEqual([
      ['main', true, null],
      ['feature', false, wt.cwd]
    ])
    expect(info.remotes.map((r) => r.name)).toEqual(['origin/remote-only'])
    expect(info.truncated).toBe(false)
    // A search covers every branch by name; the current one always stays.
    const found = await listBranches(dir, base, 'FEAT')
    expect(found.branches.map((b) => b.name)).toEqual(['main', 'feature'])
    expect((await listBranches(dir, base, 'remote-only')).remotes.map((r) => r.name)).toEqual([
      'origin/remote-only'
    ])
    expect((await listBranches(dir, base, 'nothing')).branches.map((b) => b.name)).toEqual(['main'])
    expect(info.worktrees.map((w) => [w.path, w.branch, w.main, w.app, w.current])).toEqual([
      [dir, 'main', true, false, true],
      [wt.cwd, 'feature', false, true, false]
    ])
  })

  it('creates, switches and tracks remote branches', async () => {
    const { dir, run } = await repo()
    expect(await createBranch(dir, { name: 'topic' })).toEqual({
      ok: true,
      message: 'Created and switched to topic'
    })
    expect(run('branch', '--show-current').trim()).toBe('topic')
    expect((await createBranch(dir, { name: 'later', switch: false })).message).toBe('Created later')
    expect(run('branch', '--show-current').trim()).toBe('topic')
    await expect(createBranch(dir, { name: 'topic' })).rejects.toThrow(/already exists/)
    await expect(createBranch(dir, { name: 'x', from: 'nope' })).rejects.toThrow(/No branch or commit/)

    expect(await switchBranch(dir, { branch: 'main' })).toEqual({ ok: true, message: 'Switched to main' })
    run('remote', 'add', 'origin', dir)
    run('update-ref', 'refs/remotes/origin/fix', 'HEAD')
    expect((await switchBranch(dir, { branch: 'origin/fix' })).message).toBe('Switched to fix')
    expect(run('rev-parse', '--abbrev-ref', 'fix@{upstream}').trim()).toBe('origin/fix')
    await expect(switchBranch(dir, { branch: 'ghost' })).rejects.toThrow(/No branch named/)
    await expect(switchBranch(dir, { branch: '--orphan' })).rejects.toThrow(
      /can't start with '-'/
    )
  })

  it('refuses a switch that would lose changes, with git’s reason', async () => {
    const { dir, run } = await repo()
    run('switch', '-qc', 'other')
    await writeFile(join(dir, 'a.txt'), 'other\n')
    run('commit', '-qam', 'other')
    run('switch', '-q', 'main')
    await writeFile(join(dir, 'a.txt'), 'local edit\n')
    const result = await switchBranch(dir, { branch: 'other' })
    expect(result.ok).toBe(false)
    // Git's reason with the file it names, not its closing "Aborting".
    expect(result.message).toContain('a.txt')
    expect(result.message).not.toMatch(/Aborting$/)
    expect(run('branch', '--show-current').trim()).toBe('main')
  })
})
