import type { Automation } from '../../../shared/automations'
import { ipcErrorMessage } from '../../../shared/ipc-error'
import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { toast } from '../state/toast-store'

/** How long to wait for pi to write the run's session file. */
const SESSION_WAIT_MS = 10 * 60_000

/**
 * Run an automation as a background chat: it starts without taking over the
 * window, shows up under Active on the home screen, and leaves the usual
 * unread mark and notification when it finishes.
 */
export async function runAutomation(automation: Automation): Promise<void> {
  const workspaceDir = useAppStore.getState().appInfo?.workspaceDir ?? ''
  const cwd = automation.cwd || workspaceDir
  if (!cwd) {
    return
  }
  const chats = useChatStore.getState()
  const chatId = crypto.randomUUID()
  try {
    await chats.ensureChat(chatId, { cwd })
    chats.setChatTitle(chatId, automation.name)
    await chats.send(chatId, automation.prompt, undefined, 'prompt')
  } catch (e) {
    toast(`Automation "${automation.name}" could not start: ${ipcErrorMessage(e)}`)
    return
  }
  chats.setChatTitle(chatId, automation.name)

  // Once pi has written the session file: name it after the automation and
  // remember it, so "Open last run" works after a restart.
  let done = false
  const finish = (sessionPath: string): void => {
    if (done) {
      return
    }
    done = true
    unsubscribe()
    clearTimeout(timeout)
    void window.piDesktop.chat
      .setSessionName({ chatId, name: automation.name })
      .then(() => useAppStore.getState().renameSession(sessionPath, automation.name))
      .catch(() => {})
    void window.piDesktop.automations
      .setSession({ id: automation.id, sessionPath })
      .catch(() => {})
  }
  const unsubscribe = useChatStore.subscribe((state) => {
    const sessionPath = state.chats[chatId]?.sessionPath
    if (sessionPath) {
      finish(sessionPath)
    }
  })
  const timeout = setTimeout(() => {
    done = true
    unsubscribe()
  }, SESSION_WAIT_MS)
}

let ready = false

/** Start runs main asks for (scheduled or "Run now"). Once per window. */
export function initAutomationBridge(): void {
  if (ready) {
    return
  }
  ready = true
  window.piDesktop.automations?.onRun((automation) => {
    void runAutomation(automation)
  })
}
