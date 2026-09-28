import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readAttachments } from './attachments'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-desktop-attach-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readAttachments', () => {
  it('inlines small images and keeps other files as path chips', async () => {
    // 1x1 transparent PNG.
    const png = join(dir, 'pixel.png')
    await writeFile(
      png,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      )
    )
    const doc = join(dir, 'notes.txt')
    await writeFile(doc, 'hello\n')
    const out = await readAttachments([png, doc, join(dir, 'missing.txt'), 'relative/path'])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ kind: 'image', name: 'pixel.png', mimeType: 'image/png' })
    expect(out[1]).toMatchObject({ kind: 'file', name: 'notes.txt', path: doc, size: 6 })
  })

  it('skips directories', async () => {
    await mkdir(join(dir, 'sub'))
    expect(await readAttachments([join(dir, 'sub')])).toEqual([])
  })
})
