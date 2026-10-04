import { useNavigation } from '@react-navigation/native'
import { Archive, Folder, MessagesSquare, PencilLine, Pin, Plus, Search, Trash } from 'lucide-react-native'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, SectionList, View } from 'react-native'

import {
  fuzzyFilter,
  groupByDate,
  type RemoteLiveChat,
  type SessionSearchHit,
  type SessionSummary
} from '../desktop'
import { TextSheet } from '../chat/sheets'
import { disableNotifications, enableNotifications, notificationsSupported } from '../lib/background'
import { pickFolder } from '../lib/folder-pick'
import { baseName } from '../lib/format'
import { openSession, startChat } from '../lib/open'
import type { Nav } from '../nav'
import { api, errorText } from '../remote/api'
import { useChats } from '../state/chats'
import { useConnection } from '../state/connection'
import { liveStateFor, useData } from '../state/data'
import { usePrefs } from '../state/prefs'
import { radius, space, TOUCH, useTheme } from '../theme'
import { Button, confirm, Empty, Field, Mono, Pixel, ScratchSigil, SectionLabel, Sheet, SheetAction, Sigil, Tap, toast, Txt, type PixelTone } from '../ui'
import { SessionRow } from '../ui/SessionRow'

type Entry =
  | { kind: 'session'; key: string; session: SessionSummary; status: PixelTone | null; pinned: boolean }
  /** A chat running on the computer that has no session file yet. */
  | { kind: 'live'; key: string; chat: RemoteLiveChat }
  | { kind: 'hit'; key: string; session: SessionSummary; hit: SessionSearchHit }

interface Section {
  title: string
  data: Entry[]
}

/** Sessions listed before "Show older chats" is tapped. */
const INITIAL_LIMIT = 120

const HitRow = memo(function HitRow({
  session,
  hit,
  onPress
}: {
  session: SessionSummary
  hit: SessionSearchHit
  onPress(session: SessionSummary): void
}) {
  return (
    <Tap
      onPress={() => onPress(session)}
      style={{ minHeight: TOUCH + 12, paddingHorizontal: space.lg, paddingVertical: space.sm, gap: 2 }}
    >
      <Txt numberOfLines={1}>{session.title || 'Untitled chat'}</Txt>
      <Txt size="caption" tone="muted" numberOfLines={2}>
        {hit.snippet}
      </Txt>
      <Mono size={12} tone="muted">{`${hit.matches} ${hit.matches === 1 ? 'match' : 'matches'} · ${baseName(session.cwd)}`}</Mono>
    </Tap>
  )
})

/** The chat list: what is active, what is pinned, then everything by date. */
export function ChatsTab() {
  const navigation = useNavigation<Nav>()
  const theme = useTheme()
  const sessions = useData((s) => s.sessions)
  const projects = useData((s) => s.projects)
  const meta = useData((s) => s.meta)
  const live = useData((s) => s.live)
  const loaded = useData((s) => s.loaded)
  const workspaceDir = useData((s) => s.appInfo?.workspaceDir)
  const online = useConnection((s) => s.phase === 'online')
  // A string, so a streaming chat (whose state changes many times a second)
  // does not re-render this list: only a change in what is unread does.
  const unreadKey = useChats((s) => {
    const paths: string[] = []
    for (const chat of Object.values(s.chats)) {
      if (chat.unread && chat.sessionPath) {
        paths.push(chat.sessionPath)
      }
    }
    return paths.sort().join('\n')
  })

  // Asked once, when there is something to be notified about.
  const askNotifications =
    usePrefs((s) => s.notifications === null) && notificationsSupported() && loaded && sessions.length > 0

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SessionSearchHit[]>([])
  const [showAll, setShowAll] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [menu, setMenu] = useState<SessionSummary | null>(null)
  const [renaming, setRenaming] = useState<SessionSummary | null>(null)
  const [newOpen, setNewOpen] = useState(false)

  // Sessions with a reply that arrived while their chat was off screen.
  const unread = useMemo(() => new Set(unreadKey ? unreadKey.split('\n') : []), [unreadKey])

  // Full-text search of every conversation, once the query is long enough.
  const needle = query.trim()
  useEffect(() => {
    if (needle.length < 3 || !online) {
      setHits([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      api.sessions
        .search(needle)
        .then((result) => {
          if (!cancelled) {
            setHits(result)
          }
        })
        .catch(() => {})
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [needle, online])

  const sections = useMemo<Section[]>(() => {
    const statusOf = (session: SessionSummary): PixelTone | null =>
      liveStateFor(live, session.path) ?? (unread.has(session.path) ? 'unread' : null)
    const entry = (session: SessionSummary): Entry => ({
      kind: 'session',
      key: session.path,
      session,
      status: statusOf(session),
      pinned: meta[session.path]?.pinned !== undefined
    })

    if (needle) {
      const byPath = new Map(sessions.map((s) => [s.path, s]))
      const titled = fuzzyFilter(needle, sessions, (s) => s.title).slice(0, 40)
      const out: Section[] = []
      if (titled.length > 0) {
        out.push({ title: 'Chats', data: titled.map(entry) })
      }
      const found = hits
        .map((hit) => ({ hit, session: byPath.get(hit.sessionPath) }))
        .filter((h): h is { hit: SessionSearchHit; session: SessionSummary } => h.session !== undefined)
        .slice(0, 40)
      if (found.length > 0) {
        out.push({
          title: 'In conversations',
          data: found.map(({ hit, session }) => ({ kind: 'hit', key: `hit:${session.path}`, session, hit }))
        })
      }
      return out
    }

    const visible = sessions.filter((s) => (meta[s.path]?.archived !== undefined) === showArchived)
    const known = new Set(sessions.map((s) => s.path))
    const active: Entry[] = []
    for (const chat of Object.values(live)) {
      if ((chat.streaming || chat.uiRequest) && (!chat.sessionPath || !known.has(chat.sessionPath))) {
        active.push({ kind: 'live', key: `live:${chat.chatId}`, chat })
      }
    }
    const rest: SessionSummary[] = []
    const pinned: SessionSummary[] = []
    for (const session of visible) {
      if (statusOf(session)) {
        active.push(entry(session))
      } else if (meta[session.path]?.pinned !== undefined) {
        pinned.push(session)
      } else {
        rest.push(session)
      }
    }
    const out: Section[] = []
    if (active.length > 0) {
      out.push({ title: 'Active', data: active })
    }
    if (pinned.length > 0) {
      pinned.sort((a, b) => (meta[b.path]?.pinned ?? 0) - (meta[a.path]?.pinned ?? 0))
      out.push({ title: 'Pinned', data: pinned.map(entry) })
    }
    const limited = showAll ? rest : rest.slice(0, INITIAL_LIMIT)
    for (const group of groupByDate(limited)) {
      out.push({ title: group.group, data: group.items.map(entry) })
    }
    return out
  }, [sessions, meta, live, unread, needle, hits, showAll, showArchived])

  const total = useMemo(
    () => sessions.filter((s) => (meta[s.path]?.archived !== undefined) === showArchived).length,
    [sessions, meta, showArchived]
  )
  const archivedCount = useMemo(
    () => sessions.filter((s) => meta[s.path]?.archived !== undefined).length,
    [sessions, meta]
  )

  const open = useCallback((session: SessionSummary) => void openSession(navigation, session), [navigation])

  const refresh = (): void => {
    setRefreshing(true)
    const data = useData.getState()
    void Promise.all([data.refresh(), data.refreshLive()])
      .catch((e) => toast(errorText(e)))
      .finally(() => setRefreshing(false))
  }

  const remove = async (session: SessionSummary): Promise<void> => {
    const ok = await confirm({
      title: 'Move this chat to the Trash?',
      message: `"${session.title}" goes to the Trash on the computer.`,
      action: 'Move to Trash',
      danger: true
    })
    if (ok) {
      await api.sessions.delete(session.path).catch((e) => toast(`Could not delete: ${errorText(e)}`))
    }
  }

  const recentProjects = useMemo(() => projects.slice(0, 8), [projects])

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: space.lg, paddingVertical: space.sm }}>
        <View style={{ justifyContent: 'center' }}>
          <Field
            value={query}
            onChangeText={setQuery}
            placeholder="Search chats and conversations"
            accessibilityLabel="Search chats"
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            style={{ paddingLeft: 40 }}
          />
          <View style={{ position: 'absolute', left: space.md }} pointerEvents="none">
            <Search size={17} color={theme.muted} strokeWidth={1.75} />
          </View>
        </View>
      </View>
      {askNotifications ? (
        <View
          style={{
            marginHorizontal: space.lg,
            marginBottom: space.sm,
            padding: space.md,
            gap: space.sm,
            borderRadius: radius.md,
            backgroundColor: theme.surface,
            borderWidth: 1,
            borderColor: theme.border
          }}
        >
          <Txt weight="semibold">Know when pi is done</Txt>
          <Txt size="small" tone="text2">
            Get a notification when a chat finishes or pi needs you, also with the app in the
            background.
          </Txt>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button title="Not now" style={{ flex: 1 }} onPress={() => disableNotifications()} />
            <Button
              title="Turn on"
              kind="primary"
              style={{ flex: 1 }}
              onPress={() => void enableNotifications()}
            />
          </View>
        </View>
      ) : null}
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.key}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={14}
        maxToRenderPerBatch={12}
        windowSize={9}
        removeClippedSubviews
        contentContainerStyle={{ paddingBottom: 96, flexGrow: 1 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.muted} colors={[theme.accent]} progressBackgroundColor={theme.raised} />
        }
        renderSectionHeader={({ section }) => (
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg }}>
            <SectionLabel style={{ marginBottom: space.xs }}>{section.title}</SectionLabel>
          </View>
        )}
        renderItem={({ item }) => {
          if (item.kind === 'session') {
            return (
              <SessionRow
                session={item.session}
                status={item.status}
                pinned={item.pinned}
                projectless={item.session.cwd === workspaceDir}
                onPress={open}
                onLongPress={setMenu}
              />
            )
          }
          if (item.kind === 'hit') {
            return <HitRow session={item.session} hit={item.hit} onPress={open} />
          }
          return (
            <Tap
              onPress={() =>
                navigation.navigate('Chat', {
                  chatId: useChats.getState().joinLive(item.chat.chatId, item.chat.cwd, item.chat.sessionPath)
                })
              }
              style={{ minHeight: TOUCH + 12, paddingHorizontal: space.lg, flexDirection: 'row', alignItems: 'center', gap: space.md }}
            >
              {item.chat.cwd === workspaceDir ? <ScratchSigil /> : <Sigil seed={item.chat.cwd} />}
              <View style={{ flex: 1 }}>
                <Txt numberOfLines={1}>New chat on the computer</Txt>
                <Mono size={12} tone="muted" numberOfLines={1}>
                  {`${baseName(item.chat.cwd)} · ${item.chat.uiRequest ? 'needs you' : 'working'}`}
                </Mono>
              </View>
              <Pixel tone={item.chat.uiRequest ? 'attention' : 'working'} />
            </Tap>
          )
        }}
        ListEmptyComponent={
          !loaded ? (
            <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center', padding: space.xl }}>
              <Pixel tone={online ? 'working' : 'idle'} />
              <Txt tone="muted">{online ? 'Loading chats…' : 'Waiting for the computer…'}</Txt>
            </View>
          ) : needle ? (
            <Empty icon={Search} title="No chat matches" detail={needle.length < 3 ? 'Type three letters to search inside conversations too.' : undefined} />
          ) : (
            <Empty icon={MessagesSquare} title={showArchived ? 'No archived chats' : 'No chats yet'} detail={showArchived ? undefined : 'Start one with the + button.'} />
          )
        }
        ListFooterComponent={
          needle ? null : (
            <View style={{ padding: space.lg, gap: space.xs }}>
              {!showAll && total > INITIAL_LIMIT ? (
                <Tap onPress={() => setShowAll(true)} style={{ minHeight: TOUCH, justifyContent: 'center' }}>
                  <Txt size="small" tone="accent">{`Show older chats (${total - INITIAL_LIMIT} more)`}</Txt>
                </Tap>
              ) : null}
              {archivedCount > 0 || showArchived ? (
                <Tap onPress={() => setShowArchived(!showArchived)} style={{ minHeight: TOUCH, justifyContent: 'center' }}>
                  <Txt size="small" tone="accent">
                    {showArchived ? 'Back to chats' : `Archived chats (${archivedCount})`}
                  </Txt>
                </Tap>
              ) : null}
            </View>
          )
        }
      />

      {/* New chat: the one primary action of this screen. */}
      <View
        style={{
          position: 'absolute',
          right: space.lg,
          bottom: space.lg,
          borderRadius: radius.lg,
          overflow: 'hidden',
          backgroundColor: theme.accent,
          elevation: 3
        }}
      >
        <Tap
          testID="new-chat"
          label="New chat"
          onPress={() => setNewOpen(true)}
          style={{ height: 56, paddingHorizontal: space.lg, flexDirection: 'row', alignItems: 'center', gap: space.sm }}
        >
          <Plus size={20} color={theme.onAccent} strokeWidth={2.2} />
          <Txt size="small" weight="semibold" tone="onAccent">
            New chat
          </Txt>
        </Tap>
      </View>

      <Sheet visible={newOpen} onClose={() => setNewOpen(false)} title="New chat in…">
        {workspaceDir ? (
          <SheetAction
            title="Without a project"
            detail="A scratch folder on the computer"
            onPress={() => {
              setNewOpen(false)
              startChat(navigation, workspaceDir)
            }}
          />
        ) : null}
        {recentProjects.map((project) => (
          <SheetAction
            key={project.cwd}
            icon={Folder}
            title={project.name}
            onPress={() => {
              setNewOpen(false)
              startChat(navigation, project.cwd)
            }}
          />
        ))}
        <SheetAction
          icon={Plus}
          title="Another folder…"
          detail="Browse the computer's folders"
          onPress={() => {
            setNewOpen(false)
            void pickFolder(navigation, 'New chat in…').then((path) => {
              if (path) {
                void api.projects.add(path).catch(() => {})
                startChat(navigation, path)
              }
            })
          }}
        />
      </Sheet>

      <Sheet visible={menu !== null} onClose={() => setMenu(null)} title={menu?.title || 'Chat'}>
        {menu ? (
          <>
            <SheetAction
              icon={Pin}
              title={meta[menu.path]?.pinned !== undefined ? 'Unpin' : 'Pin'}
              onPress={() => {
                void useData.getState().setMeta(menu.path, { pinned: meta[menu.path]?.pinned === undefined })
                setMenu(null)
              }}
            />
            <SheetAction
              icon={Archive}
              title={meta[menu.path]?.archived !== undefined ? 'Unarchive' : 'Archive'}
              onPress={() => {
                const archive = meta[menu.path]?.archived === undefined
                const path = menu.path
                void useData.getState().setMeta(path, { archived: archive })
                setMenu(null)
                if (archive) {
                  toast('Chat archived', {
                    action: { label: 'Undo', run: () => void useData.getState().setMeta(path, { archived: false }) }
                  })
                }
              }}
            />
            <SheetAction
              icon={PencilLine}
              title="Rename"
              onPress={() => {
                setRenaming(menu)
                setMenu(null)
              }}
            />
            <SheetAction
              icon={Trash}
              title="Move to Trash…"
              danger
              onPress={() => {
                const session = menu
                setMenu(null)
                void remove(session)
              }}
            />
          </>
        ) : null}
      </Sheet>

      <TextSheet
        visible={renaming !== null}
        title="Rename chat"
        label="Name"
        initial={renaming?.title}
        action="Rename"
        onClose={() => setRenaming(null)}
        onSubmit={(name) => {
          if (renaming) {
            void api.sessions
              .rename(renaming.path, name)
              .then(() => useData.getState().refresh())
              .catch((e) => toast(`Could not rename: ${errorText(e)}`))
          }
        }}
      />
    </View>
  )
}
