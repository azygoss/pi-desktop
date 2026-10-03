import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { createCheckpoint, restoreCheckpoint } from './checkpoints'

let repo = ''
let trashDir = ''
const trashed: string[] = []
// A stand-in for the OS trash that really takes the file away.
const trash = async (path: string): Promise<void> => {
  trashed.push(path)
  await rename(path, join(trashDir, `${trashed.length}`))
}
const run = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'pi-checkpoints-')))
  trashDir = await mkdtemp(join(tmpdir(), 'pi-checkpoints-trash-'))
  trashed.length = 0
  run('init', '-q')
  run('config', 'user.email', 'test@example.invalid')
  run('config', 'user.name', 'Test')
  run('config', 'commit.gpgsign', 'false')
  await mkdir(join(repo, 'src'))
  await writeFile(join(repo, 'src', 'a.ts'), 'one\n')
  await writeFile(join(repo, 'keep.txt'), 'keep\n')
  await writeFile(join(repo, '.gitignore'), 'ignored/\n')
  run('add', '-A')
  run('commit', '-q', '-m', 'init')
})

describe('checkpoints', () => {
  it('restores edits, deletions and new files, and can undo the restore', async () => {
    // State at the checkpoint: one uncommitted edit and one untracked file.
    await writeFile(join(repo, 'src', 'a.ts'), 'two\n')
    await writeFile(join(repo, 'notes.md'), 'draft\n')
    const checkpoint = (await createCheckpoint(repo))!
    expect(checkpoint).toMatch(/^[0-9a-f]{40,64}$/)

    // The "agent" then edits, deletes and creates files.
    await writeFile(join(repo, 'src', 'a.ts'), 'three\n')
    await rm(join(repo, 'keep.txt'))
    await writeFile(join(repo, 'src', 'new.ts'), 'created\n')

    const result = await restoreCheckpoint(repo, checkpoint, trash)
    expect(result).toMatchObject({ restored: 2, trashed: 1 })
    expect(await readFile(join(repo, 'src', 'a.ts'), 'utf8')).toBe('two\n')
    expect(await readFile(join(repo, 'keep.txt'), 'utf8')).toBe('keep\n')
    expect(await readFile(join(repo, 'notes.md'), 'utf8')).toBe('draft\n')
    expect(existsSync(join(repo, 'src', 'new.ts'))).toBe(false)
    expect(trashed).toEqual([join(repo, 'src', 'new.ts')])

    // Undo puts the agent's version back.
    const undone = await restoreCheckpoint(repo, result.undo, trash)
    // a.ts and new.ts come back; keep.txt did not exist then, so it is trashed.
    expect(undone).toMatchObject({ restored: 2, trashed: 1 })
    expect(await readFile(join(repo, 'src', 'a.ts'), 'utf8')).toBe('three\n')
    expect(existsSync(join(repo, 'keep.txt'))).toBe(false)
    expect(await readFile(join(repo, 'src', 'new.ts'), 'utf8')).toBe('created\n')
  })

  it('leaves the index, HEAD and ignored files alone', async () => {
    await writeFile(join(repo, 'staged.txt'), 'staged\n')
    run('add', 'staged.txt')
    await mkdir(join(repo, 'ignored'))
    await writeFile(join(repo, 'ignored', 'cache'), 'x')
    const head = run('rev-parse', 'HEAD')
    const status = run('status', '--porcelain')
    const checkpoint = (await createCheckpoint(repo))!
    expect(run('status', '--porcelain')).toBe(status)

    await writeFile(join(repo, 'keep.txt'), 'changed\n')
    await restoreCheckpoint(repo, checkpoint, trash)
    expect(run('rev-parse', 'HEAD')).toBe(head)
    expect(run('status', '--porcelain')).toBe(status)
    expect(existsSync(join(repo, 'ignored', 'cache'))).toBe(true)
    expect(run('for-each-ref').trim().split('\n')).toHaveLength(1) // no refs added
  })

  it('does nothing when the tree already matches, and rejects bad input', async () => {
    const checkpoint = (await createCheckpoint(repo))!
    expect(await restoreCheckpoint(repo, checkpoint, trash)).toMatchObject({
      restored: 0,
      trashed: 0
    })
    await expect(restoreCheckpoint(repo, 'HEAD; rm -rf', trash)).rejects.toThrow(/Invalid/)
    await expect(restoreCheckpoint(repo, 'a'.repeat(40), trash)).rejects.toThrow(/no longer/)
  })

  it('returns null outside a repository', async () => {
    expect(await createCheckpoint(await mkdtemp(join(tmpdir(), 'pi-no-repo-')))).toBeNull()
  })
})
