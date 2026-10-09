import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { getRepoDiff, parseShortstat } from './git-diff'

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true })
  }
})

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args]).toString()
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pidiff-'))
  dirs.push(dir)
  git(dir, ['init', '-b', 'main'])
  git(dir, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '--allow-empty', '-m', 'init'])
  return dir
}

describe('parseShortstat', () => {
  it('reads insertions and deletions', () => {
    expect(parseShortstat(' 3 files changed, 12 insertions(+), 4 deletions(-)\n')).toEqual({
      added: 12,
      removed: 4
    })
  })

  it('handles a one-sided or empty stat', () => {
    expect(parseShortstat(' 1 file changed, 1 insertion(+)')).toEqual({ added: 1, removed: 0 })
    expect(parseShortstat('')).toEqual({ added: 0, removed: 0 })
  })
})

describe('getRepoDiff untracked entries', () => {
  it('recurses into untracked directories (--untracked-files=all)', async () => {
    const dir = await repo()
    await writeFile(join(dir, 'nested-top.txt'), 'shallow\n')
    const nested = join(dir, 'fresh-dir')
    execFileSync('mkdir', [nested])
    await writeFile(join(nested, 'deep.txt'), 'deep content\n')
    const { untracked } = await getRepoDiff(dir)
    expect(untracked.map((u) => u.path).sort()).toEqual(['fresh-dir/deep.txt', 'nested-top.txt'])
    expect(untracked.find((u) => u.path === 'fresh-dir/deep.txt')?.content).toBe('deep content\n')
  })

  it('flags binary and oversized untracked files without content', async () => {
    const dir = await repo()
    await writeFile(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]))
    const big = Buffer.alloc(201 * 1024, 0x41)
    await writeFile(join(dir, 'huge.log'), big)
    const { untracked } = await getRepoDiff(dir)
    const blob = untracked.find((u) => u.path === 'blob.bin')
    const huge = untracked.find((u) => u.path === 'huge.log')
    expect(blob).toMatchObject({ content: '', binary: true })
    expect(huge).toMatchObject({ content: '', tooLarge: true })
  })

  it('shows non-ASCII tracked paths in the diff text', async () => {
    const dir = await repo()
    const name = 'yeni dosya 🚀.txt'
    await writeFile(join(dir, name), 'v1\n')
    git(dir, ['add', '--', name])
    git(dir, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-m', 'add'])
    await writeFile(join(dir, name), 'v2\n')
    const { diffText } = await getRepoDiff(dir)
    // With core.quotepath=false the path is not C-quoted.
    expect(diffText).toContain(`b/${name}`)
    expect(diffText).not.toContain('\\360')
  })
})
