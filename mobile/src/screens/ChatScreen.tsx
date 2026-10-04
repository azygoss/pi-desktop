import { useFocusEffect } from '@react-navigation/native'
import * as Clipboard from 'expo-clipboard'
import {
  Archive,
  ArrowDown,
  Copy,
  EllipsisVertical,
  GitBranch,
  GitFork,
  GitPullRequest,
  Info,
  MessageCircleQuestionMark,
  Minimize2,
  Pause,
  PencilLine,
  Pin,
  Play,
  RefreshCw,
  RotateCcw,
  Split,
  Square,
  Trash,
  Undo2
} from 'lucide-react-native'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Keyboard, KeyboardAvoidingView, View, type ListRenderItem } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { chatToMarkdown, parseSkillPrefix, thinkingLevelLabel, type DisplayMessage, type RepoSummary, type ThinkingLevel } from '../desktop'
import { Composer, PHONE_COMMANDS } from '../chat/Composer'
import { AssistantRow, BashRow, MetaRow, NoticeRow, UserRow, WorkGroupRow, type RowActions } from '../chat/MessageRows'
import { ForkSheet, isInteractive, Lightbox, ModelSheet, StatsSheet, TextSheet, UiRequestCard } from '../chat/sheets'
import { buildTranscript, type TranscriptItem } from '../chat/transcript'
import { baseName } from '../lib/format'
import { formatElapsed, useTick } from '../lib/live-clock'
import type { ScreenProps } from '../nav'
import { api, errorText } from '../remote/api'
import { useChats } from '../state/chats'
import { useConnection } from '../state/connection'
import { useData } from '../state/data'
import { space, TOUCH, useTheme } from '../theme'
import { Button, confirm, Empty, IconButton, Mono, Pixel, Screen, Sheet, SheetAction, Tap, toast, Txt } from '../ui'

type User = Extract<DisplayMessage, { kind: 'user' }>

/** "Working 0:42" — ticks on the shared clock while pi runs. */
function RunClock({ since }: { since: number }) {
  useTick()
  return (
    <Mono size={12} tone="accent" numberOfLines={1}>
      {`Working ${formatElapsed(Date.now() - since)}`}
    </Mono>
  )
}

function StartingLine({ since, hint }: { since?: number; hint?: string }) {
  useTick()
  const seconds = since ? Math.floor((Date.now() - since) / 1000) : 0
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm }}>
      <Pixel tone="working" />
      <Mono size={12} tone="muted" style={{ flex: 1 }}>
        {`Starting pi${seconds >= 2 ? ` · ${seconds}s` : ''}${hint ? ` · ${hint}` : ''}`}
      </Mono>
    </View>
  )
}

/** What pi is doing in a Mac app, with pause and stop. */
const CuaStrip = memo(function CuaStrip({ chatId }: { chatId: string }) {
  const theme = useTheme()
  const active = useChats((s) => s.chats[chatId]?.cuaActive === true)
  const paused = useChats((s) => s.chats[chatId]?.cuaPaused === true)
  const activity = useChats((s) => s.chats[chatId]?.cuaActivity)
  if (!active || !activity) {
    return null
  }
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        marginHorizontal: space.md,
        marginBottom: space.sm,
        paddingLeft: space.md,
        borderRadius: 10,
        backgroundColor: theme.accentSoft
      }}
    >
      <Pixel tone={paused ? 'attention' : 'working'} />
      <Mono size={12} tone="text" numberOfLines={1} style={{ flex: 1 }}>
        {paused ? 'Paused' : activity.app ? `Using ${activity.app} · ${activity.summary}` : activity.summary}
      </Mono>
      <IconButton
        icon={paused ? Play : Pause}
        label={paused ? 'Resume computer use' : 'Pause computer use'}
        size={16}
        onPress={() => void (paused ? api.cua.resume() : api.cua.pause()).catch((e) => toast(errorText(e)))}
      />
      <IconButton icon={Square} label="Stop computer use" size={15} tone="danger" onPress={() => void api.cua.stop().catch((e) => toast(errorText(e)))} />
    </View>
  )
})

export function ChatScreen({ navigation, route }: ScreenProps<'Chat'>) {
  const { chatId } = route.params
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const chats = useChats.getState()

  const exists = useChats((s) => s.chats[chatId] !== undefined)
  const messages = useChats((s) => s.chats[chatId]?.messages)
  const toolRuns = useChats((s) => s.chats[chatId]?.toolRuns)
  const status = useChats((s) => s.chats[chatId]?.status)
  const models = useChats((s) => s.chats[chatId]?.models)
  const title = useChats((s) => s.chats[chatId]?.title ?? 'Chat')
  const cwd = useChats((s) => s.chats[chatId]?.cwd ?? '')
  const sessionPath = useChats((s) => s.chats[chatId]?.sessionPath)
  const error = useChats((s) => s.chats[chatId]?.error)
  const stderrTail = useChats((s) => s.chats[chatId]?.stderrTail)
  const startedAt = useChats((s) => s.chats[chatId]?.startedAt)
  const startupHint = useChats((s) => s.chats[chatId]?.startupHint)
  const runStartedAt = useChats((s) => s.chats[chatId]?.runStartedAt)
  const uiRequest = useChats((s) => s.chats[chatId]?.uiRequest)
  const hasEarlier = useChats((s) => s.chats[chatId]?.hasEarlier === true)
  const stats = useChats((s) => s.chats[chatId]?.stats)
  const online = useConnection((s) => s.phase === 'online')
  const connecting = useConnection((s) => s.phase === 'connecting')
  const workspaceDir = useData((s) => s.appInfo?.workspaceDir)
  const meta = useData((s) => (sessionPath ? s.meta[sessionPath] : undefined))

  const [repo, setRepo] = useState<RepoSummary | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  const [forkOpen, setForkOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [compactOpen, setCompactOpen] = useState(false)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [userMenu, setUserMenu] = useState<{ message: User; userIndex: number } | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [awayFromEnd, setAwayFromEnd] = useState(false)
  const [keyboardUp, setKeyboardUp] = useState(false)
  const [showStderr, setShowStderr] = useState(false)
  const list = useRef<FlatList<TranscriptItem>>(null)
  const closeFork = useCallback(() => setForkOpen(false), [])
  const openModel = useCallback(() => setModelOpen(true), [])
  const openStats = useCallback(() => setStatsOpen(true), [])
  const streaming = status === 'streaming'
  const projectless = cwd !== '' && cwd === workspaceDir

  // The chat on screen is the one that never gets an unread mark.
  useFocusEffect(
    useCallback(() => {
      useChats.getState().setVisible(chatId)
      return () => useChats.getState().setVisible(null)
    }, [chatId])
  )

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardUp(true))
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardUp(false))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])

  // Branch and change counts: on open, and again whenever a run settles.
  useEffect(() => {
    if (!cwd || !online || streaming) {
      return
    }
    let cancelled = false
    api.diff
      .summary(cwd)
      .then((summary) => {
        if (!cancelled) {
          setRepo(summary.isRepo ? summary : null)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [cwd, online, streaming])

  // Display-only extension requests are acknowledged at once so the
  // extension never hangs waiting on a phone.
  useEffect(() => {
    if (uiRequest && !isInteractive(uiRequest)) {
      useChats.getState().respondUi(chatId, { id: uiRequest.id })
    }
  }, [uiRequest, chatId])

  const items = useMemo(
    () => buildTranscript(messages ?? [], streaming, models ?? []).reverse(),
    [messages, streaming, models]
  )

  const actions = useMemo<RowActions>(
    () => ({
      onUserMenu: (message, userIndex) => setUserMenu({ message, userIndex }),
      onCopy: (text: string) => {
        void Clipboard.setStringAsync(text)
        toast('Reply copied')
      },
      onImage: setLightbox,
      onOpenFile: (path) => {
        if (cwd) {
          navigation.navigate('File', { cwd, path })
        }
      }
    }),
    [cwd, navigation]
  )

  const runs = toolRuns ?? {}
  const renderItem = useCallback<ListRenderItem<TranscriptItem>>(
    ({ item }) => {
      switch (item.kind) {
        case 'user':
          return <UserRow message={item.message} userIndex={item.userIndex} actions={actions} />
        case 'assistant':
          return <AssistantRow message={item.message} toolRuns={runs} cwd={cwd} live={item.live} actions={actions} />
        case 'work':
          return (
            <WorkGroupRow
              messages={item.messages}
              toolRuns={runs}
              cwd={cwd}
              live={item.live}
              startedAt={item.startedAt}
              endedAt={item.endedAt}
              actions={actions}
            />
          )
        case 'bash':
          return <BashRow message={item.message} />
        case 'notice':
          return <NoticeRow message={item.message} />
        case 'meta':
          return <MetaRow text={item.text} reply={item.reply} onCopy={actions.onCopy} />
      }
    },
    [actions, runs, cwd]
  )

  const guard = (run: () => Promise<unknown>, failure: string): void => {
    void run().catch((e) => toast(`${failure}: ${errorText(e)}`))
  }

  /** App commands typed as `/name args`; false hands the text to pi. */
  const onCommand = useCallback(
    (command: string, args: string): boolean => {
      const store = useChats.getState()
      const chat = store.chats[chatId]
      if (!chat) {
        return false
      }
      // pi's own commands (skills, prompts, extensions) are sent as prompts.
      if (chat.commands.some((c) => c.name === command)) {
        return false
      }
      if (!PHONE_COMMANDS.has(command)) {
        return false
      }
      switch (command) {
        case 'new':
          navigation.replace('Chat', { chatId: store.newChat(chat.cwd) })
          return true
        case 'resume':
          navigation.popToTop()
          return true
        case 'name':
          if (args) {
            guard(() => store.rename(chatId, args), 'Could not rename')
          } else {
            setRenameOpen(true)
          }
          return true
        case 'session':
          setStatsOpen(true)
          return true
        case 'tree':
        case 'fork':
          setForkOpen(true)
          return true
        case 'clone':
          guard(() => store.cloneChat(chatId).then(() => toast('Continuing on a copy of the chat')), 'Could not fork the chat')
          return true
        case 'btw':
          navigation.navigate('Side', { chatId, ...(args ? { question: args } : {}) })
          return true
        case 'compact':
          guard(() => store.compact(chatId, args || undefined), 'Could not compact')
          return true
        case 'copy':
          guard(async () => {
            const { text } = await api.chat.lastAssistantText(chatId)
            if (text) {
              await Clipboard.setStringAsync(text)
              toast('Last reply copied')
            } else {
              toast('Nothing to copy yet')
            }
          }, 'Could not copy')
          return true
        case 'reload':
          guard(() => store.reloadChat(chatId).then(() => toast('pi restarted')), 'Could not restart pi')
          return true
        case 'model':
          setModelOpen(true)
          return true
        case 'thinking': {
          const wanted = args.toLowerCase()
          const match = chat.availableThinkingLevels.find(
            (l) => l === wanted || thinkingLevelLabel(l).toLowerCase() === wanted
          ) as ThinkingLevel | undefined
          if (match) {
            guard(() => store.setThinkingLevel(chatId, match), 'Could not set the level')
          } else {
            setModelOpen(true)
          }
          return true
        }
        default:
          return false
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatId, navigation]
  )

  const restoreCheckpoint = async (checkpoint: string): Promise<void> => {
    const ok = await confirm({
      title: 'Restore the files to before this prompt?',
      message:
        'Every change made to the project since then is undone, including your own edits. Files created since are moved to the Trash on the computer. The conversation stays as it is.',
      action: 'Restore files',
      danger: true
    })
    if (!ok) {
      return
    }
    const restore = async (target: string, undoable: boolean): Promise<void> => {
      try {
        const result = await api.checkpoints.restore(cwd, target)
        if (result.restored === 0 && result.trashed === 0) {
          toast('The files already match that point')
          return
        }
        const parts = [
          result.restored > 0 ? `${result.restored} ${result.restored === 1 ? 'file' : 'files'} restored` : '',
          result.trashed > 0 ? `${result.trashed} moved to Trash` : ''
        ].filter(Boolean)
        toast(parts.join(', '), undoable ? { action: { label: 'Undo', run: () => void restore(result.undo, false) } } : undefined)
      } catch (e) {
        toast(`Could not restore: ${errorText(e)}`)
      }
    }
    await restore(checkpoint, true)
  }

  const deleteChat = async (): Promise<void> => {
    if (!sessionPath) {
      navigation.goBack()
      return
    }
    const ok = await confirm({
      title: 'Move this chat to the Trash?',
      message: 'The session file goes to the Trash on the computer.',
      action: 'Move to Trash',
      danger: true
    })
    if (ok) {
      try {
        await api.sessions.delete(sessionPath)
        navigation.goBack()
      } catch (e) {
        toast(`Could not delete: ${errorText(e)}`)
      }
    }
  }

  if (!exists) {
    return (
      <Screen title="Chat" onBack={() => navigation.goBack()}>
        <Empty title="This chat is no longer open" action={<Button title="Back to chats" onPress={() => navigation.popToTop()} />} />
      </Screen>
    )
  }

  const empty = items.length === 0
  return (
    <Screen
      onBack={() => navigation.goBack()}
      bottomInset={false}
      header={
        <Tap
          style={{ flex: 1, paddingHorizontal: space.sm, minHeight: TOUCH, justifyContent: 'center' }}
          onPress={repo ? () => navigation.navigate('Diff', { cwd, chatId }) : undefined}
          accessibilityLabel={`${title}. ${repo ? `${repo.files} changed files. Open changes` : ''}`}
        >
          <Txt size="heading" weight="semibold" numberOfLines={1}>
            {title}
          </Txt>
          {streaming && runStartedAt ? (
            <RunClock since={runStartedAt} />
          ) : (
            <Mono size={12} tone="muted" numberOfLines={1}>
              {projectless ? 'no project' : baseName(cwd) || '…'}
              {repo?.branch ? ` · ${repo.branch}` : ''}
              {repo && repo.files > 0 ? (
                <>
                  {' · '}
                  <Mono size={12} tone="success">{`+${repo.added}`}</Mono>{' '}
                  <Mono size={12} tone="danger">{`−${repo.removed}`}</Mono>
                </>
              ) : null}
            </Mono>
          )}
        </Tap>
      }
      right={<IconButton icon={EllipsisVertical} label="Chat actions" onPress={() => setMenuOpen(true)} />}
    >
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        {empty ? (
          <View style={{ flex: 1 }}>
            {status === 'starting' ? null : (
              <Empty
                title="What should pi do?"
                detail={projectless ? 'This chat runs without a project.' : `pi works in ${baseName(cwd)} on your computer.`}
              />
            )}
          </View>
        ) : (
          <FlatList
            ref={list}
            data={items}
            inverted
            keyExtractor={(item) => item.key}
            renderItem={renderItem}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            initialNumToRender={12}
            maxToRenderPerBatch={8}
            windowSize={9}
            // Inverted: "flex-end" is the top of the screen, where a short
            // conversation should start.
            contentContainerStyle={{ paddingVertical: space.sm, flexGrow: 1, justifyContent: 'flex-end' }}
            onScroll={(e) => {
              const away = e.nativeEvent.contentOffset.y > 400
              if (away !== awayFromEnd) {
                setAwayFromEnd(away)
              }
            }}
            scrollEventThrottle={100}
            // The list is inverted: its footer is the top of the conversation.
            ListFooterComponent={
              hasEarlier ? (
                <View style={{ padding: space.lg, alignItems: 'center' }}>
                  <Button
                    title="Load earlier messages"
                    busy={loadingEarlier}
                    onPress={() => {
                      setLoadingEarlier(true)
                      void chats
                        .loadEarlier(chatId)
                        .catch((e) => toast(errorText(e)))
                        .finally(() => setLoadingEarlier(false))
                    }}
                  />
                </View>
              ) : null
            }
          />
        )}
        {awayFromEnd && !empty ? (
          <View
            style={{
              position: 'absolute',
              right: space.lg,
              bottom: 150,
              borderRadius: TOUCH / 2,
              backgroundColor: theme.raised,
              borderWidth: 1,
              borderColor: theme.borderStrong
            }}
          >
            <IconButton icon={ArrowDown} label="Jump to the latest message" onPress={() => list.current?.scrollToOffset({ offset: 0, animated: true })} />
          </View>
        ) : null}
        {!online ? (
          <View
            accessibilityRole="alert"
            style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm }}
          >
            <Pixel tone={connecting ? 'working' : 'error'} />
            <Mono size={12} tone="muted" style={{ flex: 1 }}>
              {connecting ? 'Reconnecting to the computer…' : 'Not connected to the computer'}
            </Mono>
            {connecting ? null : (
              <Tap onPress={() => useConnection.getState().retry()} style={{ minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: space.sm }}>
                <Txt size="small" tone="accent">
                  Retry
                </Txt>
              </Tap>
            )}
          </View>
        ) : null}
        {status === 'starting' && online ? <StartingLine since={startedAt} hint={startupHint} /> : null}
        {error ? (
          <View style={{ marginHorizontal: space.md, marginBottom: space.sm, padding: space.md, borderRadius: 10, backgroundColor: theme.dangerSoft, gap: space.sm }}>
            <Txt size="small" tone="danger" selectable>
              {error}
            </Txt>
            {showStderr && stderrTail ? (
              <Mono size={12} tone="text2" selectable>
                {stderrTail.join('\n')}
              </Mono>
            ) : null}
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              {status === 'error' || status === 'exited' ? (
                <Button title="Start pi again" onPress={() => chats.retryOpen(chatId)} />
              ) : null}
              {stderrTail && !showStderr ? <Button title="Show details" kind="ghost" onPress={() => setShowStderr(true)} /> : null}
            </View>
          </View>
        ) : null}
        <CuaStrip chatId={chatId} />
        {isInteractive(uiRequest) ? <UiRequestCard key={uiRequest.id} chatId={chatId} request={uiRequest} /> : null}
        <View style={{ paddingBottom: keyboardUp ? space.sm : insets.bottom + space.sm, backgroundColor: theme.bg }}>
          <Composer
            chatId={chatId}
            onCommand={onCommand}
            onOpenModel={openModel}
            onOpenStats={openStats}
          />
        </View>
      </KeyboardAvoidingView>

      <Sheet visible={menuOpen} onClose={() => setMenuOpen(false)} title={title}>
        {repo ? (
          <SheetAction
            icon={GitBranch}
            title="Changes"
            detail={repo.files > 0 ? `${repo.files} ${repo.files === 1 ? 'file' : 'files'} changed on ${repo.branch ?? 'this branch'}` : 'Review, commit and push'}
            onPress={() => {
              setMenuOpen(false)
              navigation.navigate('Diff', { cwd, chatId })
            }}
          />
        ) : null}
        {repo ? (
          <SheetAction
            icon={GitPullRequest}
            title="Pull request"
            onPress={() => {
              setMenuOpen(false)
              navigation.navigate('Pr', { cwd, chatId })
            }}
          />
        ) : null}
        <SheetAction
          icon={MessageCircleQuestionMark}
          title="Side chat"
          detail="Ask about this chat without adding to it"
          onPress={() => {
            setMenuOpen(false)
            navigation.navigate('Side', { chatId })
          }}
        />
        <SheetAction icon={Info} title="Session details" onPress={() => { setMenuOpen(false); setStatsOpen(true) }} />
        <SheetAction icon={PencilLine} title="Rename" onPress={() => { setMenuOpen(false); setRenameOpen(true) }} />
        <SheetAction icon={Minimize2} title="Compact context" detail="Summarize earlier messages to free up context" onPress={() => { setMenuOpen(false); setCompactOpen(true) }} />
        <SheetAction icon={Split} title="Fork from a prompt" onPress={() => { setMenuOpen(false); setForkOpen(true) }} />
        <SheetAction icon={GitFork} title="Fork chat" detail="Continue on a copy; this chat stays as it is" onPress={() => { setMenuOpen(false); onCommand('clone', '') }} />
        <SheetAction
          icon={Copy}
          title="Copy as Markdown"
          onPress={() => {
            setMenuOpen(false)
            const chat = useChats.getState().chats[chatId]
            if (chat) {
              void Clipboard.setStringAsync(chatToMarkdown(chat.title, chat.messages, chat.toolRuns, chat.cwd))
              toast('Chat copied as Markdown')
            }
          }}
        />
        <SheetAction icon={RefreshCw} title="Restart pi" detail="Reloads extensions, skills and prompts" onPress={() => { setMenuOpen(false); onCommand('reload', '') }} />
        {sessionPath ? (
          <>
            <SheetAction
              icon={Pin}
              title={meta?.pinned ? 'Unpin' : 'Pin'}
              onPress={() => {
                setMenuOpen(false)
                void useData.getState().setMeta(sessionPath, { pinned: !meta?.pinned })
              }}
            />
            <SheetAction
              icon={Archive}
              title={meta?.archived ? 'Unarchive' : 'Archive'}
              onPress={() => {
                setMenuOpen(false)
                void useData.getState().setMeta(sessionPath, { archived: !meta?.archived })
              }}
            />
            <SheetAction icon={Trash} title="Move to Trash…" danger onPress={() => { setMenuOpen(false); void deleteChat() }} />
          </>
        ) : null}
      </Sheet>

      <Sheet visible={userMenu !== null} onClose={() => setUserMenu(null)} title="Prompt">
        <SheetAction
          icon={Copy}
          title="Copy"
          onPress={() => {
            if (userMenu) {
              void Clipboard.setStringAsync(parseSkillPrefix(userMenu.message.text).rest)
              toast('Prompt copied')
            }
            setUserMenu(null)
          }}
        />
        <SheetAction
          icon={PencilLine}
          title="Edit and resend"
          detail="Branches the chat from before this prompt"
          onPress={() => {
            const target = userMenu
            setUserMenu(null)
            if (target) {
              guard(() => chats.forkFromUserMessage(chatId, target.userIndex), 'Could not fork')
            }
          }}
        />
        <SheetAction
          icon={RotateCcw}
          title="Retry"
          detail="Branches the chat and sends this prompt again"
          onPress={() => {
            const target = userMenu
            setUserMenu(null)
            if (target) {
              guard(() => chats.retryFromUserMessage(chatId, target.userIndex), 'Could not retry')
            }
          }}
        />
        {userMenu?.message.checkpoint && !streaming ? (
          <SheetAction
            icon={Undo2}
            title="Restore files to before this prompt"
            detail="Undoes the changes made to the project since"
            onPress={() => {
              const checkpoint = userMenu.message.checkpoint
              setUserMenu(null)
              if (checkpoint) {
                void restoreCheckpoint(checkpoint)
              }
            }}
          />
        ) : null}
      </Sheet>

      <ModelSheet chatId={chatId} visible={modelOpen} onClose={() => setModelOpen(false)} />
      <StatsSheet stats={stats} visible={statsOpen} onClose={() => setStatsOpen(false)} />
      <ForkSheet chatId={chatId} visible={forkOpen} onClose={closeFork} />
      <TextSheet
        visible={renameOpen}
        title="Rename chat"
        label="Name"
        initial={title}
        action="Rename"
        onClose={() => setRenameOpen(false)}
        onSubmit={(name) => guard(() => chats.rename(chatId, name), 'Could not rename')}
      />
      <TextSheet
        visible={compactOpen}
        title="Compact context"
        label="What should the summary keep? (optional)"
        action="Compact"
        multiline
        allowEmpty
        onClose={() => setCompactOpen(false)}
        onSubmit={(instructions) => guard(() => chats.compact(chatId, instructions || undefined), 'Could not compact')}
      />
      <Lightbox uri={lightbox} onClose={() => setLightbox(null)} />
    </Screen>
  )
}
