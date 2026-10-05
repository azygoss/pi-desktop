import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { toast } from '../state/toast-store'

import type { WorktreeSource } from '../../../shared/git-branches'

export function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method [^:]+: (Error: )?/,
    ''
  )
}

/** Open a new chat in `cwd`, listed and expanded in the sidebar. */
export async function newChatIn(cwd: string): Promise<void> {
  const app = useAppStore.getState()
  await app.refreshSessions()
  if (!app.appSettings.expandedProjects.includes(cwd)) {
    app.toggleProjectExpanded(cwd)
  }
  const chatId = crypto.randomUUID()
  void useChatStore
    .getState()
    .ensureChat(chatId, { cwd })
    .catch(() => {})
  useAppStore.getState().navigate({ kind: 'chat', chatId })
}

/**
 * Start a chat in a fresh git worktree of `cwd`: an isolated checkout, so it
 * can run next to other chats on the same project without sharing files.
 * By default on a new `pi/…` branch from HEAD; `source` names the branch and
 * where it starts, or checks out an existing one.
 */
export async function newChatInWorktree(cwd: string, source?: WorktreeSource): Promise<boolean> {
  try {
    const worktree = await window.piDesktop.projects.createWorktree({
      cwd,
      ...(source ? { source } : {})
    })
    await newChatIn(worktree.cwd)
    toast(`New worktree on ${worktree.branch}`)
    return true
  } catch (e) {
    toast(`Could not create a worktree: ${errorText(e)}`)
    return false
  }
}

/**
 * Open a chat in a worktree that already exists (made by the app, by git
 * on the command line or by another tool): it becomes a project first.
 */
export async function openWorktreeChat(path: string): Promise<void> {
  try {
    await window.piDesktop.projects.add({ cwd: path })
    await newChatIn(path)
  } catch (e) {
    toast(`Could not open the worktree: ${errorText(e)}`)
  }
}

/**
 * Remove a worktree the app created. Its chats close first (their pi runs in
 * that folder); the branch and the chat history stay.
 */
export async function removeWorktreeProject(cwd: string, name: string): Promise<void> {
  const confirm = await window.piDesktop.app.confirmDialog({
    title: `Remove the worktree ${name}?`,
    message:
      'Its folder is deleted and the chat history is kept. "Remove with Branch" also deletes its branch if it is merged.',
    buttons: ['Remove', 'Remove with Branch', 'Cancel'],
    danger: true
  })
  if (confirm !== 0 && confirm !== 1) {
    return
  }
  const deleteBranch = confirm === 1
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
    let result = await window.piDesktop.projects.removeWorktree({ cwd, deleteBranch })
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
      result = await window.piDesktop.projects.removeWorktree({ cwd, force: true, deleteBranch })
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
