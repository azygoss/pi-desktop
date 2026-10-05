import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readProjectImage } from './read-file'
import { pruneUploads, saveUpload } from './upload'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-upload-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('saveUpload', () => {
  it('stores the bytes under a folder of their own, readable only by the user', async () => {
    const data = Buffer.from('hello log').toString('base64')
    const a = await saveUpload(root, 'build.log', data)
    const b = await saveUpload(root, 'build.log', data)
    expect(basename(a.path)).toBe('build.log')
    expect(a.path).not.toBe(b.path)
    expect(dirname(dirname(a.path))).toBe(root)
    expect(await readFile(a.path, 'utf8')).toBe('hello log')
    expect((await stat(a.path)).mode & 0o777).toBe(0o600)
  })

  it('keeps a name from escaping its folder', async () => {
    const { path } = await saveUpload(root, '../../etc/passwd', Buffer.from('x').toString('base64'))
    expect(basename(path)).toBe('passwd')
    expect(dirname(dirname(path))).toBe(root)
    expect(basename((await saveUpload(root, '...', 'eA==')).path)).toBe('file')
  })

  it('refuses empty, malformed or oversized data', async () => {
    await expect(saveUpload(root, 'a', '')).rejects.toThrow('empty')
    await expect(saveUpload(root, 'a', 'not base64!')).rejects.toThrow('Invalid file data')
    await expect(
      saveUpload(root, 'a', Buffer.alloc(21 * 1024 * 1024).toString('base64'))
    ).rejects.toThrow('up to 20 MB')
  })
})

describe('readProjectImage', () => {
  it('reads images inside the project by their real type only', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000', 'hex')
    await writeFile(join(root, 'logo.png'), png)
    await writeFile(join(root, 'notes.png'), 'text')
    expect(await readProjectImage(root, 'logo.png')).toEqual({
      mimeType: 'image/png',
      data: png.toString('base64'),
      size: png.length
    })
    await expect(readProjectImage(root, 'notes.png')).rejects.toThrow('Not an image')
    await mkdir(join(root, 'project'))
    await expect(readProjectImage(join(root, 'project'), '../logo.png')).rejects.toThrow(
      'outside the project folder'
    )
  })
})

describe('pruneUploads', () => {
  it('drops upload folders older than a month and keeps the rest', async () => {
    const old = await saveUpload(root, 'old.txt', Buffer.from('a').toString('base64'))
    const fresh = await saveUpload(root, 'new.txt', Buffer.from('b').toString('base64'))
    const week = 31 * 24 * 60 * 60 * 1000
    await utimes(dirname(old.path), new Date(Date.now() - week), new Date(Date.now() - week))
    await pruneUploads(root)
    expect(existsSync(old.path)).toBe(false)
    expect(existsSync(fresh.path)).toBe(true)
  })

  it('refuses one byte over the limit, padding or not', async () => {
    const over = Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64')
    expect(over.endsWith('=')).toBe(false)
    await expect(saveUpload(root, 'a', over)).rejects.toThrow('up to 20 MB')
    const exact = await saveUpload(root, 'a', Buffer.alloc(20 * 1024 * 1024).toString('base64'))
    expect(exact.size).toBe(20 * 1024 * 1024)
  })

  it('keeps names Windows reserves from becoming device names', async () => {
    expect(basename((await saveUpload(root, 'NUL.txt', 'eA==')).path)).toBe('_NUL.txt')
    expect(basename((await saveUpload(root, 'notes. ', 'eA==')).path)).toBe('notes')
  })

  it('refuses an oversized upload from its length alone', async () => {
    await expect(saveUpload(root, 'a', 'A'.repeat(28 * 1024 * 1024))).rejects.toThrow('up to 20 MB')
  })
})
