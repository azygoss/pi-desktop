import type { SessionSummary } from '../desktop'
import type { Nav } from '../nav'
import { errorText } from '../remote/api'
import { useChats } from '../state/chats'
import { toast } from '../ui'

/** Open (or join) a session's chat and show it. */
export async function openSession(navigation: Nav, session: SessionSummary): Promise<void> {
  try {
    const chatId = await useChats.getState().openSession(session.path)
    navigation.navigate('Chat', { chatId })
  } catch (e) {
    toast(`Could not open the chat: ${errorText(e)}`)
  }
}

/** Start a draft chat in a folder on the computer and show it. */
export function startChat(navigation: Nav, cwd: string): void {
  navigation.navigate('Chat', { chatId: useChats.getState().newChat(cwd) })
}
