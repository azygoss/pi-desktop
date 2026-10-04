import { AppRegistry, AppState, PermissionsAndroid, Platform } from 'react-native'

import { Background, KEEP_ALIVE_TASK } from '../../modules/pi-remote-background'
import type { ChatEventPayload, ChatUiRequestPayload } from '../desktop'
import { api, EVENTS } from '../remote/api'
import { useChats } from '../state/chats'
import { onOnline, onRemote, onUnpair, setBackgroundLink, useConnection } from '../state/connection'
import { useData } from '../state/data'
import { usePrefs } from '../state/prefs'
import { baseName } from './format'

/**
 * Notifications with the app in the background.
 *
 * There is no push server: the phone hears from the computer only over its
 * own link. So while pi is working, a foreground service (the ongoing "pi is
 * working" notification) keeps the process and the link alive; when a run
 * settles or pi asks something, the app posts a notification itself. With
 * nothing running the service stops and the app sleeps like any other.
 */

/** The service outlives the last run by this long: turns often follow each other. */
const STOP_GRACE_MS = 20_000
/** Give up holding the link when the computer has been unreachable this long. */
const OFFLINE_LIMIT_MS = 5 * 60_000

let release: (() => void) | null = null
let running = false
let stopTimer: ReturnType<typeof setTimeout> | null = null
let offlineTimer: ReturnType<typeof setTimeout> | null = null
let lastText = ''

/** Must run at startup, before the service can start the task. */
export function registerKeepAliveTask(): void {
  AppRegistry.registerHeadlessTask(KEEP_ALIVE_TASK, () => () => {
    // Runs for as long as the service should: stop() resolves it.
    release?.()
    return new Promise<void>((resolve) => {
      release = resolve
    })
  })
}

export function notificationsSupported(): boolean {
  return Background !== null
}

/** Ask Android for the permission and turn notifications on if it is given. */
export async function enableNotifications(): Promise<boolean> {
  if (!Background) {
    return false
  }
  let granted = Background.notificationsAllowed()
  if (!granted && Platform.OS === 'android' && Number(Platform.Version) >= 33) {
    const result = await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS')
    granted = result === PermissionsAndroid.RESULTS.GRANTED
  }
  usePrefs.getState().set({ notifications: granted })
  sync()
  return granted
}

export function disableNotifications(): void {
  usePrefs.getState().set({ notifications: false })
  sync()
}

function enabled(): boolean {
  return Background !== null && usePrefs.getState().notifications === true
}

function titleFor(chatId: string): string {
  const draft = useChats.getState().chats[chatId]
  if (draft?.title && draft.title !== 'New chat') {
    return draft.title
  }
  const { live, sessions } = useData.getState()
  const sessionPath = draft?.sessionPath ?? live[chatId]?.sessionPath
  const session = sessionPath ? sessions.find((s) => s.path === sessionPath) : undefined
  if (session?.title) {
    return session.title
  }
  const cwd = draft?.cwd ?? live[chatId]?.cwd
  return cwd ? baseName(cwd) : 'Chat'
}

function linkFor(chatId: string): string {
  const sessionPath =
    useChats.getState().chats[chatId]?.sessionPath ?? useData.getState().live[chatId]?.sessionPath
  return `pidesktop://chat?id=${encodeURIComponent(chatId)}${
    sessionPath ? `&session=${encodeURIComponent(sessionPath)}` : ''
  }`
}

function stop(): void {
  if (stopTimer) {
    clearTimeout(stopTimer)
    stopTimer = null
  }
  if (offlineTimer) {
    clearTimeout(offlineTimer)
    offlineTimer = null
  }
  if (!running) {
    return
  }
  running = false
  lastText = ''
  setBackgroundLink(false)
  Background?.stopKeepAlive()
  release?.()
  release = null
}

/** Start, update or (after a grace period) stop the keep-alive service. */
function sync(): void {
  if (!Background) {
    return
  }
  if (!enabled() || !useConnection.getState().pairing) {
    stop()
    return
  }
  const working = Object.values(useData.getState().live).filter((chat) => chat.streaming)
  const online = useConnection.getState().phase === 'online'

  // The link is down: hold on for a while (it redials), then let go.
  if (!online) {
    if (running && !offlineTimer) {
      offlineTimer = setTimeout(stop, OFFLINE_LIMIT_MS)
    }
    return
  }
  if (offlineTimer) {
    clearTimeout(offlineTimer)
    offlineTimer = null
  }

  if (working.length === 0) {
    if (running && !stopTimer) {
      stopTimer = setTimeout(stop, STOP_GRACE_MS)
    }
    return
  }
  if (stopTimer) {
    clearTimeout(stopTimer)
    stopTimer = null
  }
  const text =
    working.length === 1 ? titleFor(working[0]!.chatId) : `${working.length} chats in progress`
  if (running && text === lastText) {
    return
  }
  // Android only lets a foreground service start while the app is on screen;
  // a run that begins with the app in the background goes without one.
  if (!running && AppState.currentState !== 'active') {
    return
  }
  if (Background.startKeepAlive('pi is working', text)) {
    running = true
    lastText = text
    setBackgroundLink(true)
  }
}

/** Markdown flattened to one short line for a notification body. */
function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

function lastReply(chatId: string): string {
  const messages = useChats.getState().chats[chatId]?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.kind === 'assistant') {
      const text = plainText(message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(' '))
      if (text) {
        return text
      }
    }
  }
  return ''
}

function alert(chatId: string, body: string): void {
  if (!enabled() || AppState.currentState === 'active') {
    return // on screen, the app says it itself
  }
  Background?.notify(chatId, titleFor(chatId), body, linkFor(chatId))
}

/**
 * Say that a chat finished. A chat this phone follows has its reply in the
 * store; for the rest (started on the computer, or long unopened) the phone
 * only heard that the run settled, so the reply is asked for.
 */
async function announceFinished(chatId: string): Promise<void> {
  if (!enabled() || AppState.currentState === 'active') {
    return
  }
  const draft = useChats.getState().chats[chatId]
  let body = draft && !draft.stale ? lastReply(chatId) : ''
  if (!body) {
    body = await api.chat
      .lastAssistantText(chatId)
      .then((result) => plainText(result.text ?? ''))
      .catch(() => '')
  }
  alert(chatId, body || 'pi finished')
}

let wired = false

/** Follow the app's state and the computer's events. Once, at launch. */
export function initBackground(): void {
  if (wired || !Background) {
    return
  }
  wired = true

  useData.subscribe((state, previous) => {
    if (state.live !== previous.live) {
      sync()
    }
  })
  useConnection.subscribe((state, previous) => {
    if (state.phase !== previous.phase) {
      sync()
    }
  })
  usePrefs.subscribe((state, previous) => {
    if (state.notifications !== previous.notifications) {
      sync()
    }
  })
  onOnline(sync)
  onUnpair(() => {
    stop()
    Background?.cancelAlerts()
  })

  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      // Whatever was announced is now in front of the user.
      Background?.cancelAlerts()
      sync()
    }
  })

  onRemote<ChatEventPayload>(EVENTS.chatEvent, ({ chatId, events }) => {
    if (events.some((e) => e.type === 'agent_settled')) {
      // A beat later, so the chat store has taken in the final message.
      setTimeout(() => void announceFinished(chatId), 600)
    }
  })
  onRemote<ChatUiRequestPayload>(EVENTS.chatUiRequest, ({ chatId, request }) => {
    if (
      request.method === 'confirm' ||
      request.method === 'select' ||
      request.method === 'input' ||
      request.method === 'editor'
    ) {
      alert(chatId, `pi needs you${request.title ? `: ${request.title}` : ''}`)
    }
  })
  onRemote<{ chatId: string }>(EVENTS.chatUiResolved, ({ chatId }) => {
    Background?.cancel(chatId)
  })
}

/** The link the app was opened with, kept natively until asked for (once). */
export function takeLaunchLink(prefix: string): string | null {
  return Background?.takeLaunchLink(prefix) ?? null
}

/** A notification's link: `pidesktop://chat?id=…&session=…`. */
export function parseChatLink(url: string | null): { chatId: string; sessionPath?: string } | null {
  if (!url || !url.startsWith('pidesktop://chat?')) {
    return null
  }
  const fields = new Map<string, string>()
  for (const pair of url.slice('pidesktop://chat?'.length).split('&')) {
    const at = pair.indexOf('=')
    if (at > 0) {
      try {
        fields.set(pair.slice(0, at), decodeURIComponent(pair.slice(at + 1)))
      } catch {
        return null
      }
    }
  }
  const chatId = fields.get('id')
  if (!chatId || !/^[A-Za-z0-9_-]{1,64}$/.test(chatId)) {
    return null
  }
  const sessionPath = fields.get('session')
  return { chatId, ...(sessionPath ? { sessionPath } : {}) }
}

/** Show the chat a notification was about, once the computer is reachable. */
export function openChatLink(url: string | null, navigate: (chatId: string) => void): boolean {
  const target = parseChatLink(url)
  if (!target) {
    return false
  }
  const open = async (): Promise<void> => {
    const chats = useChats.getState()
    if (chats.chats[target.chatId]) {
      navigate(target.chatId)
      return
    }
    if (target.sessionPath) {
      navigate(await chats.openSession(target.sessionPath))
      return
    }
    await useData.getState().refreshLive()
    const live = useData.getState().live[target.chatId]
    if (live) {
      navigate(chats.joinLive(live.chatId, live.cwd, live.sessionPath))
    }
  }
  if (useConnection.getState().phase === 'online') {
    void open().catch(() => {})
  } else {
    // Launched from the notification: the link is still coming up.
    const off = onOnline(() => {
      off()
      void open().catch(() => {})
    })
  }
  return true
}
