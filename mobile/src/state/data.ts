import { create } from 'zustand'

import type {
  AppInfo,
  ChatEventPayload,
  ChatUiRequestPayload,
  ProjectSummary,
  RemoteLiveChat,
  SessionMetaMap,
  SessionMetaPatch,
  SessionSummary
} from '../desktop'
import { api, EVENTS } from '../remote/api'
import { onOnline, onRemote } from './connection'

interface DataState {
  /** False until the first answer from the computer. */
  loaded: boolean
  sessions: SessionSummary[]
  projects: ProjectSummary[]
  meta: SessionMetaMap
  /** Chats with a live pi process on the computer, by chat id. */
  live: Record<string, RemoteLiveChat>
  appInfo: AppInfo | null
  userName: string
  refresh(): Promise<void>
  refreshLive(): Promise<void>
  setMeta(sessionPath: string, patch: SessionMetaPatch): Promise<void>
}

export const useData = create<DataState>((set, get) => ({
  loaded: false,
  sessions: [],
  projects: [],
  meta: {},
  live: {},
  appInfo: null,
  userName: '',

  async refresh() {
    const [sessions, projects] = await Promise.all([api.sessions.list(), api.projects.list()])
    set({ sessions, projects, loaded: true })
  },

  async refreshLive() {
    const list = await api.chat.live()
    const live: Record<string, RemoteLiveChat> = {}
    for (const chat of list) {
      live[chat.chatId] = chat
    }
    set({ live })
  },

  async setMeta(sessionPath, patch) {
    // Optimistic, like the desktop: the broadcast brings the authoritative map.
    const current = { ...(get().meta[sessionPath] ?? {}) }
    if (patch.pinned !== undefined) {
      if (patch.pinned) {
        current.pinned = Date.now()
      } else {
        delete current.pinned
      }
    }
    if (patch.archived !== undefined) {
      if (patch.archived) {
        current.archived = Date.now()
      } else {
        delete current.archived
      }
    }
    set({ meta: { ...get().meta, [sessionPath]: current } })
    const map = await api.sessions.setMeta(sessionPath, patch).catch(() => null)
    if (map) {
      set({ meta: map })
    }
  }
}))

/** Whether pi is working in, or waiting on the user of, a session. */
export function liveStateFor(
  live: Record<string, RemoteLiveChat>,
  sessionPath: string
): 'working' | 'attention' | null {
  for (const chat of Object.values(live)) {
    if (chat.sessionPath === sessionPath) {
      return chat.uiRequest ? 'attention' : chat.streaming ? 'working' : null
    }
  }
  return null
}

const SESSIONS_REFRESH_MS = 2000

let wired = false
let sessionsTimer: ReturnType<typeof setTimeout> | null = null
let liveTimer: ReturnType<typeof setTimeout> | null = null

function patchLive(chatId: string, patch: Partial<RemoteLiveChat>): void {
  const live = useData.getState().live
  const current = live[chatId]
  if (!current) {
    // A chat this phone has not heard of: ask the computer what is running.
    if (!liveTimer) {
      liveTimer = setTimeout(() => {
        liveTimer = null
        void useData.getState().refreshLive().catch(() => {})
      }, 250)
    }
    return
  }
  useData.setState({ live: { ...live, [chatId]: { ...current, ...patch } } })
}

/** Keep the lists in step with the computer. Once, at launch. */
export function initDataBridge(): void {
  if (wired) {
    return
  }
  wired = true

  onOnline(() => {
    const state = useData.getState()
    void state.refresh().catch(() => {})
    void state.refreshLive().catch(() => {})
    void api.sessions
      .meta()
      .then((meta) => useData.setState({ meta }))
      .catch(() => {})
    void api.app
      .info()
      .then((appInfo) => useData.setState({ appInfo }))
      .catch(() => {})
    void api.app
      .userFirstName()
      .then((userName) => useData.setState({ userName }))
      .catch(() => {})
  })

  onRemote(EVENTS.sessionsChanged, () => {
    // pi appends to session files the whole time it works, and each refresh
    // downloads the full list: at most one every couple of seconds.
    if (!sessionsTimer) {
      sessionsTimer = setTimeout(() => {
        sessionsTimer = null
        void useData.getState().refresh().catch(() => {})
      }, SESSIONS_REFRESH_MS)
    }
  })
  onRemote<SessionMetaMap>(EVENTS.sessionMetaChanged, (meta) => {
    if (meta && typeof meta === 'object') {
      useData.setState({ meta })
    }
  })
  onRemote<ChatEventPayload>(EVENTS.chatEvent, ({ chatId, events }) => {
    for (const event of events) {
      if (event.type === 'agent_start') {
        patchLive(chatId, { streaming: true })
      } else if (event.type === 'agent_settled') {
        patchLive(chatId, { streaming: false })
      }
    }
  })
  onRemote<ChatUiRequestPayload>(EVENTS.chatUiRequest, ({ chatId, request }) => {
    if (request.method !== 'notify') {
      patchLive(chatId, { uiRequest: request })
    }
  })
  onRemote<{ chatId: string }>(EVENTS.chatUiResolved, ({ chatId }) => {
    patchLive(chatId, { uiRequest: undefined })
  })
  onRemote<{ chatId: string }>(EVENTS.chatExit, ({ chatId }) => {
    const live = { ...useData.getState().live }
    delete live[chatId]
    useData.setState({ live })
  })
}
