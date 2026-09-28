import type { SessionSummary } from '../../../shared/session-types'
import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { toast } from '../state/toast-store'

/**
 * Pin/archive plumbing shared by the sidebar row menu, the TitleBar "…"
 * menu and the command palette. All flags live in app-side session-meta;
 * pi's own session files are never touched.
 */

/** Find the chat id of the open chat showing `sessionPath`, if any. */
function chatIdForSession(sessionPath: string): string | undefined {
  const chats = useChatStore.getState().chats
  return Object.values(chats).find(
    (c) => c.sessionPath === sessionPath && c.status !== 'exited'
  )?.chatId
}

export async function setSessionPinned(sessionPath: string, pinned: boolean): Promise<void> {
  await useAppStore.getState().setSessionMeta(sessionPath, { pinned })
}

export async function setSessionArchived(sessionPath: string, archived: boolean): Promise<void> {
  await useAppStore.getState().setSessionMeta(sessionPath, { archived })
}

/**
 * Archive a session by path. When the archived chat is the one on screen the
 * app navigates home first, then shows an Undo toast.
 */
export async function archiveSessionPath(sessionPath: string): Promise<void> {
  const chatId = chatIdForSession(sessionPath)
  const view = useAppStore.getState().view
  const wasOpen = chatId !== undefined && view.kind === 'chat' && view.chatId === chatId
  if (wasOpen) {
    useAppStore.getState().navigate({ kind: 'home' })
  }
  await setSessionArchived(sessionPath, true)
  toast('Chat archived', {
    action: { label: 'Undo', run: () => void setSessionArchived(sessionPath, false) }
  })
}

export async function archiveSession(session: SessionSummary): Promise<void> {
  await archiveSessionPath(session.path)
}

/** Pin/Unpin/Archive/Unarchive dispatch shared by the native menus. */
export async function runSessionMenuAction(
  session: SessionSummary,
  action: 'pin' | 'unpin' | 'archive' | 'unarchive'
): Promise<void> {
  switch (action) {
    case 'pin':
      await setSessionPinned(session.path, true)
      break
    case 'unpin':
      await setSessionPinned(session.path, false)
      break
    case 'archive':
      await archiveSession(session)
      break
    case 'unarchive':
      await setSessionArchived(session.path, false)
      break
  }
}
