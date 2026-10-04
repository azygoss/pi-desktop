import AsyncStorage from '@react-native-async-storage/async-storage'
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
import { onComputerRemoved, onOnline, onRemote, onUnpair, useConnection } from './connection'

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
const CACHE_KEY = 'pi-remote.lists'
/** One cache per paired computer: switching shows that computer's lists at once. */
const cacheKey = (computer: string): string => `${CACHE_KEY}:${computer}`
/** Sessions kept for the next cold start (the newest ones). */
const CACHE_SESSIONS = 300
/** The cache only serves the next launch: writing it rarely is enough. */
const CACHE_WRITE_MS = 20_000

let wired = false
let listsVisible = true
let listsDirty = false
let cacheTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The lists as last seen, so a cold start paints the chat list at once and
 * the computer's answer replaces it a moment later. Tied to the computer's
 * key: another pairing never sees them.
 */
function scheduleCacheWrite(): void {
  if (cacheTimer) {
    return
  }
  cacheTimer = setTimeout(() => {
    cacheTimer = null
    const key = useConnection.getState().pairing?.key
    const { sessions, projects, meta, appInfo, loaded } = useData.getState()
    if (!key || !loaded) {
      return
    }
    void AsyncStorage.setItem(
      cacheKey(key),
      JSON.stringify({ key, sessions: sessions.slice(0, CACHE_SESSIONS), projects, meta, appInfo })
    ).catch(() => {})
  }, CACHE_WRITE_MS)
}

async function restoreCache(): Promise<void> {
  try {
    const key = useConnection.getState().pairing?.key
    if (!key) {
      return
    }
    // Before several computers there was one cache, under the plain key.
    const legacy = await AsyncStorage.getItem(CACHE_KEY)
    if (legacy !== null) {
      await AsyncStorage.removeItem(CACHE_KEY).catch(() => {})
    }
    const raw = (await AsyncStorage.getItem(cacheKey(key))) ?? legacy
    const cached = raw ? (JSON.parse(raw) as Partial<DataState> & { key?: string }) : null
    if (!cached || !key || cached.key !== key || useData.getState().loaded) {
      return
    }
    useData.setState({
      sessions: Array.isArray(cached.sessions) ? cached.sessions : [],
      projects: Array.isArray(cached.projects) ? cached.projects : [],
      meta: cached.meta && typeof cached.meta === 'object' ? cached.meta : {},
      appInfo: cached.appInfo ?? null,
      loaded: true
    })
  } catch {
    // no cache: the lists arrive with the connection
  }
}

function refreshLists(): void {
  listsDirty = false
  void useData
    .getState()
    .refresh()
    .then(scheduleCacheWrite)
    .catch(() => {})
}

/**
 * Whether a screen showing the lists is on top. While a chat covers them,
 * session changes (pi appends to the file the whole time it works) only
 * mark the lists stale; they are fetched when the user comes back.
 */
export function setListsVisible(visible: boolean): void {
  listsVisible = visible
  if (visible && listsDirty && useConnection.getState().phase === 'online') {
    refreshLists()
  }
}
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
    refreshLists()
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
    if (!listsVisible) {
      listsDirty = true
      return
    }
    if (!sessionsTimer) {
      sessionsTimer = setTimeout(() => {
        sessionsTimer = null
        refreshLists()
      }, SESSIONS_REFRESH_MS)
    }
  })
  onRemote<SessionMetaMap>(EVENTS.sessionMetaChanged, (meta) => {
    if (meta && typeof meta === 'object') {
      useData.setState({ meta })
      scheduleCacheWrite()
    }
  })

  onUnpair(() => {
    useData.setState({
      loaded: false,
      sessions: [],
      projects: [],
      meta: {},
      live: {},
      appInfo: null,
      userName: ''
    })
  })
  onComputerRemoved((key) => {
    void AsyncStorage.removeItem(cacheKey(key)).catch(() => {})
  })

  // Whenever another computer comes into use (and at launch, once the
  // pairing is known): show its cached lists until it answers.
  let shownFor: string | null = null
  useConnection.subscribe((state) => {
    const key = state.pairing?.key ?? null
    if (key !== shownFor) {
      shownFor = key
      if (key) {
        void restoreCache()
      }
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
