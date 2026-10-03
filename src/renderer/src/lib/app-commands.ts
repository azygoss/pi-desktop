import { isAbsolute, joinPath } from './paths'
import type { ChatState } from '../state/chat-store'
import { useAppStore } from '../state/app-store'
import { useChatStore } from '../state/chat-store'
import { openInBrowser, openPiTerminal, usePanelStore } from '../state/panel-store'
import { toast } from '../state/toast-store'

export type ChatModal = 'session' | 'tree' | 'fork' | 'hotkeys'

export interface AppCommandContext {
  /** The chat the composer belongs to, or null on the home screen. */
  chat: ChatState | null
  /** Open the model picker popover (also used by /thinking). */
  openModelPicker(): void
  /** Open an app modal (session/tree/fork/hotkeys). */
  setModal(modal: ChatModal): void
}

/**
 * Execute an app-side slash command (pi's built-ins surfaced locally).
 * Anything not listed here is not an app command — see isAppCommand.
 */
export async function executeAppCommand(
  ctx: AppCommandContext,
  command: string,
  args: string
): Promise<void> {
  const app = useAppStore.getState()
  const chats = useChatStore.getState()
  const chat = ctx.chat
  const workspaceDir = app.appInfo?.workspaceDir ?? ''
  const chatCwd = chat?.cwd || workspaceDir

  switch (command) {
    // Models and settings
    case 'settings':
      app.openSettings()
      break
    case 'model':
      if (!args) {
        ctx.openModelPicker()
      } else if (chat) {
        setModelByArg(chat, args)
      } else {
        toast('Open a chat to pick a model')
      }
      break
    case 'thinking':
      if (!args) {
        ctx.openModelPicker()
      } else if (chat) {
        const level = args.toLowerCase()
        if (!chat.availableThinkingLevels.includes(level as never)) {
          toast(`Unknown thinking level for this model: ${args}`)
        } else {
          void chats.setThinkingLevel(chat.chatId, level as never)
        }
      } else {
        toast('Open a chat to set the thinking level')
      }
      break

    // pi TUI-only commands → terminal tabs
    case 'scoped-models':
    case 'logout':
    case 'llama':
    case 'trust':
      void openPiTerminal(chatCwd, command, args).catch((e) =>
        toast(`Could not open terminal: ${errText(e)}`)
      )
      break
    case 'login':
      void openPiTerminal(chatCwd, command, args).catch((e) =>
        toast(`Could not open terminal: ${errText(e)}`)
      )
      break
    case 'share':
    case 'bug': {
      if (!chat?.sessionPath) {
        toast('Send a message first — this chat has no session yet')
        break
      }
      if (chat.status === 'streaming') {
        toast('Wait for the reply to finish')
        break
      }
      void openPiTerminal(chat.cwd, command, args, chat.sessionPath).catch((e) =>
        toast(`Could not open terminal: ${errText(e)}`)
      )
      break
    }

    // Sessions and context
    case 'new':
      app.navigate({ kind: 'home' })
      break
    case 'resume':
      if (app.sidebarCollapsed) {
        app.toggleSidebar()
      }
      app.setSidebarSearchOpen(true)
      break
    case 'name':
      if (!chat) {
        break
      }
      if (!args) {
        toast(chat.title === 'New chat' ? 'This chat has no name' : `Name: ${chat.title}`)
      } else {
        void window.piDesktop.chat
          .setSessionName({ chatId: chat.chatId, name: args })
          .then(() => {
            chats.setChatTitle(chat.chatId, args)
            if (chat.sessionPath) {
              app.renameSession(chat.sessionPath, args)
            }
          })
          .catch(() => toast('Could not rename the chat'))
      }
      break
    case 'session':
      ctx.setModal('session')
      break
    case 'tree':
      ctx.setModal('tree')
      break
    case 'fork':
      ctx.setModal('fork')
      break
    case 'clone':
      if (chat) {
        void chats.cloneChat(chat.chatId).catch(() => toast('Clone failed'))
      }
      break
    case 'btw':
      if (chat) {
        usePanelStore.getState().openSide(chat.chatId, args)
      }
      break
    case 'compact':
      if (chat) {
        void window.piDesktop.chat
          .compact({ chatId: chat.chatId, customInstructions: args || undefined })
          .catch(() => toast('Compact failed'))
      }
      break
    case 'import':
      await importSession(args)
      break

    // Export and share
    case 'copy':
      if (!chat) {
        break
      }
      try {
        const { text } = await window.piDesktop.chat.getLastAssistantText({
          chatId: chat.chatId
        })
        if (!text) {
          toast('Nothing to copy yet')
        } else {
          await navigator.clipboard.writeText(text)
          toast('Copied to clipboard')
        }
      } catch {
        toast('Copy failed')
      }
      break
    case 'export':
      await exportChat(chat, args)
      break

    // Runtime and project
    case 'reload':
      if (chat) {
        try {
          await chats.reloadChat(chat.chatId)
          toast('pi reloaded')
        } catch {
          toast('Reload failed')
        }
      }
      break
    case 'hotkeys':
      ctx.setModal('hotkeys')
      break
    case 'changelog':
      openInBrowser('https://pi.dev/changelog')
      break
    case 'quit': {
      const streaming = Object.values(chats.chats).some((c) => c.status === 'streaming')
      if (streaming) {
        const choice = await window.piDesktop.app.confirmDialog({
          title: 'A chat is still running. Quit anyway?',
          buttons: ['Quit', 'Cancel'],
          danger: true
        })
        if (choice !== 0) {
          break
        }
      }
      void window.piDesktop.app.quit()
      break
    }
  }
}

/** Resolve `provider/model` or a bare model id/name to a set_model call. */
function setModelByArg(chat: ChatState, args: string): void {
  const chats = useChatStore.getState()
  const slash = args.indexOf('/')
  if (slash !== -1) {
    const provider = args.slice(0, slash)
    const modelId = args.slice(slash + 1)
    const found = chat.models.find((m) => m.provider === provider && m.id === modelId)
    if (!found) {
      toast(`Unknown model: ${args}`)
      return
    }
    void chats.setModel(chat.chatId, provider, modelId)
    return
  }
  const matches = chat.models.filter((m) => m.id === args || m.name === args)
  if (matches.length === 0) {
    toast(`Unknown model: ${args}`)
  } else if (matches.length > 1) {
    toast(`Ambiguous model "${args}" — use provider/model`)
  } else {
    const m = matches[0]!
    void chats.setModel(chat.chatId, m.provider, m.id)
  }
}

async function importSession(args: string): Promise<void> {
  const path =
    args ||
    (await window.piDesktop.app.pickFile([
      { name: 'pi session', extensions: ['jsonl'] }
    ]).catch(() => null))
  if (!path) {
    return
  }
  try {
    const { sessionPath } = await window.piDesktop.sessions.import({ path })
    await useAppStore.getState().refreshSessions()
    const chatId = crypto.randomUUID()
    void useChatStore.getState().ensureChat(chatId, { sessionPath }).catch(() => {})
    useAppStore.getState().navigate({ kind: 'chat', chatId })
  } catch (e) {
    toast(`Import failed: ${errText(e)}`)
  }
}

async function exportChat(chat: ChatState | null, args: string): Promise<void> {
  if (!chat) {
    return
  }
  if (!chat.sessionPath) {
    toast('Send a message first — this chat has no session yet')
    return
  }
  const sessionPath = chat.sessionPath
  let outputPath = args
  if (outputPath && !isAbsolute(outputPath)) {
    outputPath = joinPath(chat.cwd, outputPath)
  }
  if (!outputPath) {
    const safeTitle = chat.title.replace(/[^a-zA-Z0-9-_ ]+/g, '').trim() || 'chat'
    const picked = await window.piDesktop.app.saveFile({
      defaultPath: `${safeTitle}.html`,
      extension: 'html'
    })
    if (!picked) {
      return
    }
    outputPath = picked
  }
  try {
    await window.piDesktop.sessions.exportFile({ sessionPath, outputPath })
    const choice = await window.piDesktop.app.confirmDialog({
      title: 'Chat exported',
      message: `Saved to ${outputPath}`,
      buttons: ['Reveal in Finder', 'OK']
    })
    if (choice === 0) {
      await window.piDesktop.app.revealPath(outputPath)
    }
  } catch (e) {
    toast(`Export failed: ${errText(e)}`)
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
