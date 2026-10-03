import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { toast } from '../state/toast-store'

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method [^:]+: (Error: )?/,
    ''
  )
}

/**
 * Start a chat in a fresh git worktree of `cwd`: an isolated checkout on its
 * own `pi/…` branch, so it can run next to other chats on the same project
 * without sharing files.
 */
export async function newChatInWorktree(cwd: string): Promise<void> {
  try {
    const worktree = await window.piDesktop.projects.createWorktree({ cwd })
    const app = useAppStore.getState()
    await app.refreshSessions()
    if (!app.appSettings.expandedProjects.includes(worktree.cwd)) {
      app.toggleProjectExpanded(worktree.cwd)
    }
    const chatId = crypto.randomUUID()
    void useChatStore
      .getState()
      .ensureChat(chatId, { cwd: worktree.cwd })
      .catch(() => {})
    useAppStore.getState().navigate({ kind: 'chat', chatId })
    toast(`New worktree on ${worktree.branch}`)
  } catch (e) {
    toast(`Could not create a worktree: ${errorText(e)}`)
  }
}

/**
 * Remove a worktree the app created. Its chats close first (their pi runs in
 * that folder); the branch and the chat history stay.
 */
export async function removeWorktreeProject(cwd: string, name: string): Promise<void> {
  const confirm = await window.piDesktop.app.confirmDialog({
    title: `Remove the worktree ${name}?`,
    message: 'Its folder is deleted. The branch and the chat history are kept.',
    buttons: ['Remove', 'Cancel'],
    danger: true
  })
  if (confirm !== 0) {
    return
  }
  const chats = useChatStore.getState()
  const app = useAppStore.getState()
  for (const chat of Object.values(chats.chats)) {
    if (chat.cwd === cwd) {
      if (app.view.kind === 'chat' && app.view.chatId === chat.chatId) {
        app.navigate({ kind: 'home' })
      }
      await chats.closeChat(chat.chatId)
    }
  }
  try {
    let result = await window.piDesktop.projects.removeWorktree({ cwd })
    if (!result.ok) {
      const force = await window.piDesktop.app.confirmDialog({
        title: 'This worktree has uncommitted changes',
        message: `${result.message}\n\nRemoving it discards those changes.`,
        buttons: ['Discard and Remove', 'Cancel'],
        danger: true
      })
      if (force !== 0) {
        return
      }
      result = await window.piDesktop.projects.removeWorktree({ cwd, force: true })
    }
    toast(result.ok ? result.message : `Could not remove the worktree: ${result.message}`)
    if (result.ok) {
      // The folder is gone; its sessions remain but the project row would
      // point nowhere, so hide it.
      const settings = useAppStore.getState().appSettings
      await useAppStore
        .getState()
        .updateAppSettings({ hiddenProjects: [...settings.hiddenProjects, cwd] })
    }
  } catch (e) {
    toast(`Could not remove the worktree: ${errorText(e)}`)
  }
}
