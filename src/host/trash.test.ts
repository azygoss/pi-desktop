import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { moveToTrash } from './trash'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-remote-trash-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('moveToTrash', () => {
  it('follows the freedesktop trash spec on Linux', async () => {
    const file = join(root, 'work', 'notes 1.jsonl')
    await mkdir(join(root, 'work'))
    await writeFile(file, 'session')
    const dataHome = join(root, 'share')
    await moveToTrash(file, {
      platform: 'linux',
      home: root,
      dataHome,
      now: new Date(2026, 9, 5, 1, 2, 3)
    })
    expect(existsSync(file)).toBe(false)
    expect(await readFile(join(dataHome, 'Trash/files/notes 1.jsonl'), 'utf8')).toBe('session')
    expect(await readFile(join(dataHome, 'Trash/info/notes 1.jsonl.trashinfo'), 'utf8')).toBe(
      `[Trash Info]\nPath=${join(root, 'work').split('/').map(encodeURIComponent).join('/')}/notes%201.jsonl\nDeletionDate=2026-10-05T01:02:03\n`
    )
  })

  it('never overwrites what is already in the trash', async () => {
    const dataHome = join(root, 'share')
    for (const content of ['first', 'second', 'third']) {
      await writeFile(join(root, 'a.txt'), content)
      await moveToTrash(join(root, 'a.txt'), { platform: 'linux', home: root, dataHome })
    }
    const files = (await readdir(join(dataHome, 'Trash/files'))).sort()
    expect(files).toEqual(['a 2.txt', 'a 3.txt', 'a.txt'])
    expect(await readFile(join(dataHome, 'Trash/files/a 3.txt'), 'utf8')).toBe('third')
    expect((await readdir(join(dataHome, 'Trash/info'))).sort()).toEqual([
      'a 2.txt.trashinfo',
      'a 3.txt.trashinfo',
      'a.txt.trashinfo'
    ])
  })

  it('moves whole folders', async () => {
    const dir = join(root, 'project')
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'index.ts'), 'x')
    await moveToTrash(dir, { platform: 'darwin', home: root })
    expect(existsSync(dir)).toBe(false)
    expect(await readFile(join(root, '.Trash/project/src/index.ts'), 'utf8')).toBe('x')
  })

  it('leaves no info file behind when the move fails', async () => {
    const dataHome = join(root, 'share')
    await expect(
      moveToTrash(join(root, 'missing.txt'), { platform: 'linux', home: root, dataHome })
    ).rejects.toThrow()
    expect(await readdir(join(dataHome, 'Trash/info'))).toEqual([])
  })
})
