import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ReviewComment } from '../../shared/review'
import { ReviewCommentStore } from './comment-store'

let dir: string
let changes: { cwd: string; comments: ReviewComment[] }[]
let store: ReviewCommentStore
const file = () => join(dir, 'review-comments.json')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'review-comments-'))
  changes = []
  store = new ReviewCommentStore(file(), (cwd, comments) => changes.push({ cwd, comments }))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ReviewCommentStore', () => {
  it('keeps comments per project and announces every change', async () => {
    const added = await store.add('/work/a', {
      path: 'src/x.ts',
      line: 3,
      lineText: 'const x = 1',
      text: '  Rename x  '
    })
    expect(added).toMatchObject({ path: 'src/x.ts', line: 3, text: 'Rename x' })
    expect(await store.list('/work/a')).toEqual([added])
    expect(await store.list('/work/b')).toEqual([])
    expect(changes).toEqual([{ cwd: '/work/a', comments: [added] }])
  })

  it('survives a restart in a private file', async () => {
    await store.add('/work/a', { path: 'a.ts', text: 'Note' })
    await store.flush()
    expect((await stat(file())).mode & 0o777).toBe(0o600)
    const again = new ReviewCommentStore(file(), () => {})
    expect((await again.list('/work/a')).map((c) => c.text)).toEqual(['Note'])
    expect(await readFile(file(), 'utf8')).toContain('"version":1')
  })

  it("replaces pi's earlier remarks and keeps yours", async () => {
    await store.add('/w', { path: 'a.ts', text: 'Mine' })
    await store.replacePi('/w', [{ path: 'a.ts', line: 1, comment: 'First pass' }])
    const after = await store.replacePi('/w', [
      { path: 'b.ts', line: 2, comment: 'Second pass' },
      { path: '../escape', comment: 'Dropped' }
    ])
    expect(after.map((c) => [c.author ?? 'you', c.text])).toEqual([
      ['you', 'Mine'],
      ['pi', 'Second pass']
    ])
  })

  it('removes by id and clears per file or all', async () => {
    const one = await store.add('/w', { path: 'a.ts', text: '1' })
    await store.add('/w', { path: 'b.ts', text: '2' })
    await store.add('/w', { path: 'c.ts', text: '3' })
    expect((await store.remove('/w', [one.id])).map((c) => c.text)).toEqual(['2', '3'])
    expect((await store.clear('/w', ['b.ts'])).map((c) => c.text)).toEqual(['3'])
    expect(await store.clear('/w')).toEqual([])
  })

  it('rejects empty comments and paths outside the repository', async () => {
    await expect(store.add('/w', { path: 'a.ts', text: '  ' })).rejects.toThrow('empty')
    await expect(store.add('/w', { path: '/etc/passwd', text: 'x' })).rejects.toThrow('path')
    await expect(store.add('/w', { path: 'a/../../b', text: 'x' })).rejects.toThrow('path')
  })
})
