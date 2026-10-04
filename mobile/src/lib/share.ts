import { File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'

import { api } from '../remote/api'

/** A name safe as a file name, from a chat title. */
function fileStem(title: string): string {
  const clean = title
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return clean || 'pi-chat'
}

/** Write to the cache and open the share sheet (save, send, open elsewhere). */
async function shareFile(name: string, write: (file: File) => void, mimeType: string, dialogTitle: string): Promise<void> {
  const file = new File(Paths.cache, name)
  if (file.exists) {
    file.delete()
  }
  write(file)
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle })
}

/** A data: URI image (a screenshot pi took, an image it showed). */
export async function shareDataUri(uri: string): Promise<void> {
  const match = /^data:([^;]+);base64,(.+)$/.exec(uri)
  if (!match) {
    return
  }
  const mimeType = match[1]!
  const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
  await shareFile(`pi-image-${Date.now()}.${ext}`, (file) => file.write(match[2]!, { encoding: 'base64' }), mimeType, 'Share image')
}

/** The whole chat as pi's standalone HTML export. */
export async function shareChatHtml(sessionPath: string, title: string): Promise<void> {
  const { html } = await api.chat.exportHtml(sessionPath)
  await shareFile(`${fileStem(title)}.html`, (file) => file.write(html), 'text/html', 'Share chat')
}
