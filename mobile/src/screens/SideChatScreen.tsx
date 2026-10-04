import { randomUUID } from 'expo-crypto'
import { ArrowUp, RotateCcw, Square } from 'lucide-react-native'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  FlatList,
  KeyboardAvoidingView,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Markdown } from '../chat/Markdown'
import {
  createChatViewState,
  reducePiEvent,
  type ChatViewState,
  type DisplayMessage,
  type SideEventPayload
} from '../desktop'
import type { ScreenProps } from '../nav'
import { api, errorText, EVENTS } from '../remote/api'
import { useChats } from '../state/chats'
import { onRemote } from '../state/connection'
import { makeStyles, radius, space } from '../theme'
import { Button, Field, IconButton, Mono, Pixel, Screen, toast, Txt } from '../ui'

/** Streamed tokens reach React at most this often. */
const PUBLISH_MS = 60

const useStyles = makeStyles((t) => ({
  list: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.lg },
  question: {
    flexDirection: 'row',
    gap: space.sm,
    backgroundColor: t.userBlock,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm
  },
  answer: { gap: space.sm },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 24 },
  footer: { gap: space.md, paddingTop: space.xs },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: t.border,
    backgroundColor: t.bg
  },
  input: { flex: 1, maxHeight: 132 }
}))

const SideMessage = memo(function SideMessage({ message }: { message: DisplayMessage }) {
  const styles = useStyles()
  if (message.kind === 'user') {
    return (
      <View style={styles.question}>
        <Mono size={15} tone="muted" style={{ lineHeight: 24 }}>
          ›
        </Mono>
        <Txt selectable style={{ flex: 1 }}>
          {message.text}
        </Txt>
      </View>
    )
  }
  if (message.kind === 'notice') {
    return (
      <Txt size="small" tone={message.tone === 'error' ? 'danger' : 'muted'}>
        {message.text}
      </Txt>
    )
  }
  if (message.kind !== 'assistant') {
    return null
  }
  return (
    <View style={styles.answer}>
      {message.blocks.map((block, i) =>
        block.type === 'text' ? (
          block.text ? (
            <Markdown key={i} text={block.text} />
          ) : null
        ) : block.type === 'thinking' ? (
          <Mono key={i} size={12} tone="muted">
            {message.streaming && block.durationMs === undefined ? 'thinking…' : 'thought'}
          </Mono>
        ) : block.type === 'toolCall' ? (
          <Mono key={i} size={12} tone="muted" numberOfLines={1}>
            {block.name}
          </Mono>
        ) : null
      )}
      {message.errorMessage ? (
        <Txt size="small" tone="danger">
          {message.errorMessage}
        </Txt>
      ) : null}
    </View>
  )
})

const messageKey = (message: DisplayMessage): string => message.key

type Phase = 'starting' | 'ready' | 'error' | 'ended'

/**
 * A side chat: questions answered with the chat's context that leave nothing
 * behind in it. pi runs on a scratch copy of the session on the computer;
 * leaving the screen ends it.
 */
export function SideChatScreen({ navigation, route }: ScreenProps<'Side'>) {
  const { chatId, question } = route.params
  const styles = useStyles()
  const insets = useSafeAreaInsets()

  // Events are reduced into this mutable state; `shown` is what React renders.
  const view = useRef<ChatViewState>(createChatViewState())
  const [shown, setShown] = useState<Pick<ChatViewState, 'messages' | 'status'>>({
    messages: [],
    status: 'idle'
  })
  const [phase, setPhase] = useState<Phase>('starting')
  const [error, setError] = useState<string | null>(null)
  const [hasHistory, setHasHistory] = useState(true)
  const [text, setText] = useState('')
  /** Bumped by "restart": a fresh side chat on the chat as it is now. */
  const [generation, setGeneration] = useState(0)

  const sideId = useRef('')
  const opened = useRef<Promise<void> | null>(null)
  const publishTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const asked = useRef(false)
  const optimistic = useRef(0)
  const listRef = useRef<FlatList<DisplayMessage>>(null)
  const atBottom = useRef(true)

  const publishNow = useCallback(() => {
    if (publishTimer.current) {
      clearTimeout(publishTimer.current)
      publishTimer.current = null
    }
    setShown({ messages: view.current.messages.slice(), status: view.current.status })
  }, [])

  const publishSoon = useCallback(() => {
    if (publishTimer.current) {
      return
    }
    publishTimer.current = setTimeout(() => {
      publishTimer.current = null
      setShown({ messages: view.current.messages.slice(), status: view.current.status })
    }, PUBLISH_MS)
  }, [])

  const send = useCallback(
    async (message: string): Promise<void> => {
      const value = message.trim()
      const id = sideId.current
      if (!value || !id || view.current.status === 'streaming') {
        return
      }
      view.current.messages.push({
        kind: 'user',
        key: `side-user-${++optimistic.current}`,
        text: value,
        images: []
      })
      view.current.status = 'streaming'
      atBottom.current = true
      publishNow()
      try {
        await opened.current
        await api.side.send(id, value)
      } catch (e) {
        if (sideId.current === id) {
          view.current.status = 'idle'
          publishNow()
          toast(errorText(e))
        }
      }
    },
    [publishNow]
  )

  useEffect(() => {
    // Read once per start: the side chat is a snapshot of the chat right now.
    const chat = useChats.getState().chats[chatId]
    view.current = createChatViewState()
    publishNow()
    if (!chat) {
      sideId.current = ''
      opened.current = null
      setPhase('error')
      setError('This chat is no longer open.')
      return
    }
    const id = `s-${randomUUID()}`
    let alive = true
    sideId.current = id
    setPhase('starting')
    setError(null)
    setHasHistory(!!chat.sessionPath)

    const offEvent = onRemote<SideEventPayload>(EVENTS.sideEvent, (payload) => {
      if (payload.sideId !== id) {
        return
      }
      for (const event of payload.events) {
        reducePiEvent(view.current, event)
      }
      publishSoon()
    })
    const offExit = onRemote<{ sideId: string }>(EVENTS.sideExit, (payload) => {
      if (payload.sideId !== id) {
        return
      }
      view.current.status = 'idle'
      publishNow()
      setPhase('ended')
      setError('The side chat stopped')
    })

    const promise = api.side.open({
      sideId: id,
      cwd: chat.cwd,
      ...(chat.sessionPath ? { sessionPath: chat.sessionPath } : {}),
      ...(chat.model ? { model: { provider: chat.model.provider, modelId: chat.model.id } } : {})
    })
    opened.current = promise
    promise.then(
      () => {
        if (!alive) {
          return
        }
        setPhase((current) => (current === 'starting' ? 'ready' : current))
        // A question handed over with the route is asked once.
        if (question && !asked.current) {
          asked.current = true
          void send(question)
        }
      },
      (e: unknown) => {
        if (alive) {
          view.current.status = 'idle'
          publishNow()
          setPhase('error')
          setError(errorText(e))
        }
      }
    )

    return () => {
      alive = false
      offEvent()
      offExit()
      if (publishTimer.current) {
        clearTimeout(publishTimer.current)
        publishTimer.current = null
      }
      void api.side.close(id).catch(() => {})
    }
  }, [chatId, generation, question, publishNow, publishSoon, send])

  const streaming = shown.status === 'streaming'
  const dead = phase === 'error' || phase === 'ended'
  const restart = (): void => setGeneration((g) => g + 1)

  const submit = (): void => {
    if (streaming) {
      void api.side.abort(sideId.current).catch((e: unknown) => toast(errorText(e)))
      return
    }
    if (!text.trim() || dead) {
      return
    }
    void send(text)
    setText('')
  }

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
    atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80
  }

  const renderItem = useCallback(
    ({ item }: { item: DisplayMessage }) => <SideMessage message={item} />,
    []
  )

  const footer = (
    <View style={styles.footer}>
      {shown.messages.length === 0 && !dead ? (
        <Txt size="small" tone="muted">
          {hasHistory
            ? 'pi answers with this chat as context. Nothing said here is added to the chat.'
            : 'This chat has no history yet, so pi answers without its context.'}
        </Txt>
      ) : null}
      {phase === 'starting' ? (
        <View style={styles.status}>
          <Pixel tone="working" />
          <Txt size="small" tone="muted">
            Starting…
          </Txt>
        </View>
      ) : streaming ? (
        <View style={styles.status}>
          <Pixel tone="working" />
          <Txt size="small" tone="accent">
            Working
          </Txt>
        </View>
      ) : null}
      {dead && error ? (
        <View style={{ gap: space.md, alignItems: 'flex-start' }}>
          <View style={styles.status}>
            <Pixel tone="error" />
            <Txt size="small" tone="danger" style={{ flex: 1 }}>
              {error}
            </Txt>
          </View>
          <Button title="Start again" icon={RotateCcw} onPress={restart} />
        </View>
      ) : null}
    </View>
  )

  return (
    <Screen
      title="Side chat"
      subtitle="Nothing here is added to the chat"
      onBack={() => navigation.goBack()}
      right={
        <IconButton
          icon={RotateCcw}
          label="Start over with the chat as it is now"
          onPress={restart}
        />
      }
      bottomInset={false}
    >
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <FlatList
          ref={listRef}
          style={{ flex: 1 }}
          data={shown.messages}
          keyExtractor={messageKey}
          renderItem={renderItem}
          ListFooterComponent={footer}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          onScroll={onScroll}
          scrollEventThrottle={64}
          onContentSizeChange={() => {
            if (atBottom.current) {
              listRef.current?.scrollToEnd({ animated: false })
            }
          }}
        />
        <View style={[styles.composer, { paddingBottom: insets.bottom + space.sm }]}>
          <Field
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Ask a side question"
            multiline
            editable={!dead}
            accessibilityLabel="Side question"
          />
          {streaming ? (
            <IconButton icon={Square} label="Stop" tone="danger" size={18} onPress={submit} />
          ) : (
            <IconButton
              icon={ArrowUp}
              label="Ask"
              tone="accent"
              size={22}
              onPress={submit}
              disabled={dead || !text.trim()}
            />
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  )
}
