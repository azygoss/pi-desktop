import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { readProjectFile } from './read-file'

async function project(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-read-file-')))
  await mkdir(join(dir, 'src'))
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
  return dir
}

describe('readProjectFile', () => {
  it('reads a file by relative or absolute path', async () => {
    const cwd = await project()
    const rel = await readProjectFile(cwd, 'src/a.ts')
    expect(rel).toMatchObject({ relativePath: 'src/a.ts', binary: false, truncated: false })
    expect(rel.content).toBe('export const a = 1\n')
    expect((await readProjectFile(cwd, join(cwd, 'src', 'a.ts'))).content).toBe(rel.content)
  })

  it('refuses paths outside the project, including through a symlink', async () => {
    const cwd = await project()
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'pi-read-outside-')))
    await writeFile(join(outside, 'secret.txt'), 'nope')
    await expect(readProjectFile(cwd, '../x')).rejects.toThrow()
    await expect(readProjectFile(cwd, join(outside, 'secret.txt'))).rejects.toThrow(/outside/)
    await symlink(join(outside, 'secret.txt'), join(cwd, 'link.txt'))
    await expect(readProjectFile(cwd, 'link.txt')).rejects.toThrow(/outside/)
  })

  it('refuses denied directories and flags binary files', async () => {
    const cwd = await project()
    await mkdir(join(cwd, 'agent'))
    await writeFile(join(cwd, 'agent', 'auth.json'), '{}')
    await expect(readProjectFile(cwd, 'agent/auth.json', [join(cwd, 'agent')])).rejects.toThrow()
    await writeFile(join(cwd, 'bin.dat'), Buffer.from([1, 0, 2]))
    expect(await readProjectFile(cwd, 'bin.dat')).toMatchObject({ binary: true, content: '' })
  })
})
