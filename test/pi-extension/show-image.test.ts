import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// @ts-expect-error -- plain JS module loaded by pi, no type declarations
import { showImage } from '../../resources/pi-extension/pi-desktop-browser/show-image.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex')

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'show-image-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

type Result = {
  content: { type: string; data?: string; mimeType?: string; text?: string }[]
  details: unknown
}

describe('show_image', () => {
  it('returns the images by their real type, and a caption line for the model', async () => {
    await writeFile(join(dir, 'shot.png'), PNG)
    await writeFile(join(dir, 'photo.jpg'), JPEG)
    const result = (await showImage(
      { paths: ['shot.png', join(dir, 'photo.jpg')], caption: 'Before and after' },
      dir
    )) as Result
    expect(result.content.map((b) => b.mimeType ?? b.type)).toEqual([
      'image/png',
      'image/jpeg',
      'text'
    ])
    expect(result.content[0]!.data).toBe(PNG.toString('base64'))
    expect(result.content[2]!.text).toBe(
      `Shown to the user: shot.png, ${join(dir, 'photo.jpg')} — Before and after`
    )
    expect(result.details).toEqual({
      paths: ['shot.png', join(dir, 'photo.jpg')],
      caption: 'Before and after'
    })
  })

  it('refuses what is not an image, whatever its name', async () => {
    await writeFile(join(dir, 'fake.png'), 'not an image')
    await expect(showImage({ paths: ['fake.png'] }, dir)).rejects.toThrow(
      'is not a PNG, JPEG, GIF or WebP image (.png)'
    )
  })

  it('explains missing files and limits', async () => {
    await expect(showImage({ paths: ['nope.png'] }, dir)).rejects.toThrow('No such file: nope.png')
    await expect(showImage({ paths: [] }, dir)).rejects.toThrow('at least one image')
    await writeFile(join(dir, 'a.png'), PNG)
    await expect(
      showImage({ paths: ['a.png', 'a.png', 'a.png', 'a.png', 'a.png'] }, dir)
    ).rejects.toThrow('At most 4')
    await writeFile(join(dir, 'big.png'), Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]))
    await expect(showImage({ paths: ['big.png'] }, dir)).rejects.toThrow('the limit is 8 MB')
  })
})
