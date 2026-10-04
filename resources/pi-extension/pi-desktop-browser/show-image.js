// show_image: put image files in front of the user, in Pi Desktop's chat and
// on a paired phone (Pi Remote). Needs no bridge, so it is registered in the
// desktop app and in pi-remote (the headless host) alike.

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, resolve } from 'node:path'

const MAX_IMAGES = 4
const MAX_BYTES = 8 * 1024 * 1024

/** The image type from the file's first bytes (the extension can lie). */
function sniff(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6 && bytes.subarray(0, 4).toString('ascii') === 'GIF8') {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

function resolvePath(path, cwd) {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
}

export const SHOW_IMAGE_TOOL = {
  name: 'show_image',
  label: 'Show Image',
  description:
    "Show image files to the user in the chat: they appear at full size in Pi Desktop and in the Pi Remote phone app, with your caption. Use it whenever the user wants to see something visual — a screenshot you saved (e.g. with a headless browser or a CLI), a chart or diagram you generated, a rendered page or design. It works even if you cannot look at images yourself. PNG, JPEG, GIF or WebP, up to 8 MB each, at most 4 per call.",
  schema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Image file paths (absolute, ~/…, or relative to the working directory)'
      },
      caption: { type: 'string', description: 'One line telling the user what they are looking at' }
    },
    required: ['paths']
  }
}

export async function showImage(params, cwd = process.cwd()) {
  const paths = Array.isArray(params?.paths)
    ? params.paths.filter((p) => typeof p === 'string' && p.trim())
    : typeof params?.path === 'string'
      ? [params.path]
      : []
  if (paths.length === 0) {
    throw new Error('Give at least one image path in "paths".')
  }
  if (paths.length > MAX_IMAGES) {
    throw new Error(`At most ${MAX_IMAGES} images per call.`)
  }
  const content = []
  const shown = []
  for (const path of paths) {
    const file = resolvePath(path.trim(), cwd)
    const info = await stat(file).catch(() => null)
    if (!info || !info.isFile()) {
      throw new Error(`No such file: ${path}`)
    }
    if (info.size > MAX_BYTES) {
      throw new Error(`${path} is ${(info.size / 1048576).toFixed(1)} MB; the limit is 8 MB. Save a smaller or JPEG version and show that.`)
    }
    const bytes = await readFile(file)
    const mimeType = sniff(bytes)
    if (!mimeType) {
      throw new Error(`${path} is not a PNG, JPEG, GIF or WebP image${extname(file) ? ` (${extname(file)})` : ''}.`)
    }
    content.push({ type: 'image', data: bytes.toString('base64'), mimeType })
    shown.push(path)
  }
  const caption = typeof params?.caption === 'string' ? params.caption.trim() : ''
  content.push({
    type: 'text',
    text: `Shown to the user: ${shown.join(', ')}${caption ? ` — ${caption}` : ''}`
  })
  return { content, details: { paths: shown, ...(caption ? { caption } : {}) } }
}
