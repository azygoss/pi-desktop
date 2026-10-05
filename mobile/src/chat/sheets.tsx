import * as Clipboard from 'expo-clipboard'
import { Share2, X } from 'lucide-react-native'
import { memo, useEffect, useMemo, useState } from 'react'
import { FlatList, Image, Modal, PixelRatio, ScrollView, SectionList, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import {
  flattenSessionTree,
  providerLabel,
  thinkingLevelLabel,
  type TreeRow,
  type ChatSessionStats,
  type ExtensionUiRequest,
  type ForkMessage,
  type Model,
  type ThinkingLevel
} from '../desktop'
import { compactNumber, formatCost } from '../lib/format'
import { shareDataUri } from '../lib/share'
import { api, errorText } from '../remote/api'
import { useChats } from '../state/chats'
import { radius, space, TOUCH, useTheme } from '../theme'
import { Button, Divider, Empty, Field, IconButton, Mono, Pixel, Row, SectionLabel, Sheet, Tap, toast, Txt } from '../ui'

// ---------------------------------------------------------------------------
// Model and thinking level
// ---------------------------------------------------------------------------

const ModelRow = memo(function ModelRow({
  model,
  selected,
  onPick
}: {
  model: Model
  selected: boolean
  onPick(model: Model): void
}) {
  return (
    <Tap
      onPress={() => onPick(model)}
      accessibilityState={{ selected }}
      style={{
        minHeight: TOUCH,
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md
      }}
    >
      <View style={{ flex: 1 }}>
        <Txt weight={selected ? 'semibold' : 'regular'} numberOfLines={1}>
          {model.name || model.id}
        </Txt>
        <Mono size={12} tone="muted" numberOfLines={1}>
          {`${model.id} · ${compactNumber(model.contextWindow)} ctx`}
        </Mono>
      </View>
      {selected ? <Pixel tone="unread" /> : null}
    </Tap>
  )
})

/** Models grouped by provider for a SectionList, filtered by `query`. */
function modelSections(models: Model[] | undefined, query: string, skip?: Model | null) {
  const needle = query.trim().toLowerCase()
  const byProvider = new Map<string, Model[]>()
  for (const model of models ?? []) {
    if (skip && model.provider === skip.provider && model.id === skip.id) {
      continue
    }
    if (
      needle &&
      !model.name.toLowerCase().includes(needle) &&
      !model.id.toLowerCase().includes(needle) &&
      !model.provider.toLowerCase().includes(needle)
    ) {
      continue
    }
    const list = byProvider.get(model.provider)
    if (list) {
      list.push(model)
    } else {
      byProvider.set(model.provider, [model])
    }
  }
  return [...byProvider.entries()].map(([provider, data]) => ({
    title: providerLabel(provider),
    data
  }))
}

/**
 * What to review the changes with: the chat's own model, or any other one pi
 * offers (a second model looking over the first one's work).
 */
export function ReviewSheet({
  chatId,
  visible,
  onClose,
  onPick
}: {
  chatId: string
  visible: boolean
  onClose(): void
  onPick(model: Model | null): void
}) {
  const theme = useTheme()
  const models = useChats((s) => s.chats[chatId]?.models)
  const current = useChats((s) => s.chats[chatId]?.model ?? null)
  const [query, setQuery] = useState('')
  const sections = useMemo(() => modelSections(models, query, current), [models, query, current])
  const pick = (model: Model | null): void => {
    onClose()
    setQuery('')
    onPick(model)
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Review with" scroll={false}>
      {current ? (
        <>
          <SectionLabel style={{ paddingHorizontal: space.lg }}>This chat&apos;s model</SectionLabel>
          <ModelRow model={current} selected onPick={() => pick(current)} />
          <Divider />
        </>
      ) : null}
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm }}>
        <SectionLabel>Another model</SectionLabel>
        {(models?.length ?? 0) > 10 ? (
          <Field
            value={query}
            onChangeText={setQuery}
            placeholder="Search models"
            accessibilityLabel="Search models"
            autoCorrect={false}
            autoCapitalize="none"
          />
        ) : null}
      </View>
      <SectionList
        style={{ maxHeight: 360 }}
        sections={sections}
        keyExtractor={(model) => `${model.provider}/${model.id}`}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={14}
        renderSectionHeader={({ section }) => (
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, backgroundColor: theme.raised }}>
            <SectionLabel>{section.title}</SectionLabel>
          </View>
        )}
        renderItem={({ item }) => <ModelRow model={item} selected={false} onPick={pick} />}
        ListEmptyComponent={<Empty title={query.trim() ? 'No model matches' : 'No other models'} />}
      />
    </Sheet>
  )
}

/** Pick the chat's model (grouped by provider) and its thinking effort. */
export function ModelSheet({
  chatId,
  visible,
  onClose
}: {
  chatId: string
  visible: boolean
  onClose(): void
}) {
  const theme = useTheme()
  const models = useChats((s) => s.chats[chatId]?.models)
  const current = useChats((s) => s.chats[chatId]?.model)
  const level = useChats((s) => s.chats[chatId]?.thinkingLevel)
  const levels = useChats((s) => s.chats[chatId]?.availableThinkingLevels)
  const [query, setQuery] = useState('')

  const sections = useMemo(() => modelSections(models, query), [models, query])

  const pick = (model: Model): void => {
    onClose()
    void useChats
      .getState()
      .setModel(chatId, model.provider, model.id)
      .catch((e) => toast(`Could not switch model: ${errorText(e)}`))
  }
  const setLevel = (next: ThinkingLevel): void => {
    void useChats
      .getState()
      .setThinkingLevel(chatId, next)
      .catch((e) => toast(errorText(e)))
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Model" scroll={false}>
      {levels && levels.length > 1 ? (
        <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md }}>
          <SectionLabel>Thinking effort</SectionLabel>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
            {levels.map((option) => {
              const selected = option === level
              return (
                <View
                  key={option}
                  style={{
                    borderRadius: radius.md,
                    overflow: 'hidden',
                    borderWidth: 1,
                    borderColor: selected ? theme.accent : theme.borderStrong,
                    backgroundColor: selected ? theme.accentSoft : 'transparent'
                  }}
                >
                  <Tap
                    onPress={() => setLevel(option)}
                    accessibilityState={{ selected }}
                    style={{ minHeight: 44, minWidth: 64, paddingHorizontal: space.md, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Mono size={13} tone={selected ? 'accent' : 'text2'} weight={selected ? 'medium' : 'regular'}>
                      {thinkingLevelLabel(option)}
                    </Mono>
                  </Tap>
                </View>
              )
            })}
          </ScrollView>
        </View>
      ) : null}
      {(models?.length ?? 0) > 10 ? (
        <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
          <Field
            value={query}
            onChangeText={setQuery}
            placeholder="Search models"
            accessibilityLabel="Search models"
            autoCorrect={false}
            autoCapitalize="none"
          />
        </View>
      ) : null}
      <SectionList
        style={{ maxHeight: 420 }}
        sections={sections}
        keyExtractor={(model) => `${model.provider}/${model.id}`}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={14}
        renderSectionHeader={({ section }) => (
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, backgroundColor: theme.raised }}>
            <SectionLabel>{section.title}</SectionLabel>
          </View>
        )}
        renderItem={({ item }) => (
          <ModelRow
            model={item}
            selected={item.provider === current?.provider && item.id === current?.id}
            onPick={pick}
          />
        )}
        ListEmptyComponent={
          <Empty title={models?.length ? 'No model matches' : 'No models yet'} detail={models?.length ? undefined : 'pi is still starting.'} />
        }
      />
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// pi's questions (extension UI requests)
// ---------------------------------------------------------------------------

type Interactive = Extract<ExtensionUiRequest, { method: 'select' | 'confirm' | 'input' | 'editor' }>

export function isInteractive(request: ExtensionUiRequest | undefined): request is Interactive {
  return (
    request !== undefined &&
    (request.method === 'select' ||
      request.method === 'confirm' ||
      request.method === 'input' ||
      request.method === 'editor')
  )
}

/**
 * pi needs you: a confirm, a choice or some text an extension asked for.
 * Amber, because it is waiting on the user. Answering here also closes the
 * same dialog in the window on the computer.
 */
export function UiRequestCard({ chatId, request }: { chatId: string; request: Interactive }) {
  const theme = useTheme()
  const respond = useChats.getState().respondUi
  const prefill = (request.method === 'editor' ? (request as { prefill?: string }).prefill : undefined) ?? ''
  const [value, setValue] = useState(prefill)
  const title = request.title ?? (request.method === 'confirm' ? 'Confirm' : 'pi needs your input')
  const message = (request as { message?: string }).message
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        marginHorizontal: space.md,
        marginBottom: space.sm,
        padding: space.md,
        gap: space.md,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: theme.warning,
        backgroundColor: theme.warningSoft
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Pixel tone="attention" />
        <Txt weight="semibold" style={{ flex: 1 }}>
          {title}
        </Txt>
      </View>
      {message ? (
        <ScrollView style={{ maxHeight: 120 }}>
          <Txt size="small" tone="text2">
            {message}
          </Txt>
        </ScrollView>
      ) : null}
      {request.method === 'select' ? (
        // Many options scroll inside the card; the composer stays on screen.
        <ScrollView style={{ maxHeight: 264 }} contentContainerStyle={{ gap: space.sm }} keyboardShouldPersistTaps="handled">
          {request.options.map((option) => (
            <Button key={option} title={option} onPress={() => respond(chatId, { id: request.id, value: option })} />
          ))}
          <Button title="Cancel" kind="ghost" onPress={() => respond(chatId, { id: request.id, cancelled: true })} />
        </ScrollView>
      ) : request.method === 'confirm' ? (
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Button
            title="Cancel"
            style={{ flex: 1 }}
            onPress={() => respond(chatId, { id: request.id, confirmed: false, cancelled: true })}
          />
          <Button
            title="Confirm"
            kind="primary"
            style={{ flex: 1 }}
            onPress={() => respond(chatId, { id: request.id, confirmed: true })}
          />
        </View>
      ) : (
        <>
          <Field
            value={value}
            onChangeText={setValue}
            multiline={request.method === 'editor'}
            accessibilityLabel={title}
            placeholder={(request as { placeholder?: string }).placeholder}
            style={request.method === 'editor' ? { minHeight: 96, maxHeight: 180, textAlignVertical: 'top' } : undefined}
          />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button title="Cancel" style={{ flex: 1 }} onPress={() => respond(chatId, { id: request.id, cancelled: true })} />
            <Button
              title="Send"
              kind="primary"
              style={{ flex: 1 }}
              onPress={() => respond(chatId, { id: request.id, value })}
            />
          </View>
        </>
      )}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Session stats
// ---------------------------------------------------------------------------

export function StatsSheet({
  stats,
  visible,
  onClose,
  sessionPath,
  onCompact
}: {
  stats: ChatSessionStats | undefined
  visible: boolean
  onClose(): void
  sessionPath?: string
  /** Summarize earlier messages now (offered when context fills up). */
  onCompact?(): void
}) {
  const percent = stats?.contextUsage?.percent ?? null
  const rows: [string, string][] = stats
    ? [
        ['Context', stats.contextUsage?.percent != null ? `${Math.round(stats.contextUsage.percent)}% of ${compactNumber(stats.contextUsage.contextWindow ?? 0)}` : '—'],
        ['Messages', `${stats.userMessages ?? 0} prompts · ${stats.assistantMessages ?? 0} replies`],
        ['Tool calls', String(stats.toolCalls ?? 0)],
        ['Input tokens', compactNumber(stats.tokens?.input ?? 0)],
        ['Output tokens', compactNumber(stats.tokens?.output ?? 0)],
        ['Cache read / write', `${compactNumber(stats.tokens?.cacheRead ?? 0)} / ${compactNumber(stats.tokens?.cacheWrite ?? 0)}`],
        ['Cost', formatCost(stats.cost ?? 0)]
      ]
    : []
  return (
    <Sheet visible={visible} onClose={onClose} title="Session">
      {stats ? (
        rows.map(([label, value]) => (
          <Row key={label} title={label} right={<Mono size={13}>{value}</Mono>} />
        ))
      ) : (
        <Empty title="No stats yet" detail="They appear once pi has answered." />
      )}
      {sessionPath ? (
        <Row
          title="Session file"
          detail={sessionPath}
          onLongPress={() => {
            void Clipboard.setStringAsync(sessionPath)
            toast('Path copied')
          }}
        />
      ) : null}
      {onCompact ? (
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.xs }}>
          <Button
            title="Compact now"
            kind={percent !== null && percent >= 70 ? 'primary' : 'secondary'}
            onPress={() => {
              onClose()
              onCompact()
            }}
          />
          <Txt size="caption" tone="muted">
            {percent !== null && percent >= 70
              ? 'Context is filling up: a summary of earlier messages frees room for the rest of the work.'
              : 'Summarizes earlier messages to free up context.'}
          </Txt>
        </View>
      ) : null}
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Text prompt (rename, compact instructions)
// ---------------------------------------------------------------------------

export function TextSheet({
  visible,
  title,
  label,
  initial,
  action,
  multiline,
  allowEmpty,
  onClose,
  onSubmit
}: {
  visible: boolean
  title: string
  label: string
  initial?: string
  action: string
  multiline?: boolean
  allowEmpty?: boolean
  onClose(): void
  onSubmit(value: string): void
}) {
  const [value, setValue] = useState(initial ?? '')
  useEffect(() => {
    if (visible) {
      setValue(initial ?? '')
    }
  }, [visible, initial])
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <View style={{ paddingHorizontal: space.lg, gap: space.sm, paddingBottom: space.md }}>
        <Txt size="small" tone="text2">
          {label}
        </Txt>
        <Field
          value={value}
          onChangeText={setValue}
          autoFocus
          multiline={multiline}
          accessibilityLabel={label}
          style={multiline ? { minHeight: 96, textAlignVertical: 'top' } : undefined}
        />
        <Button
          title={action}
          kind="primary"
          disabled={!allowEmpty && !value.trim()}
          onPress={() => {
            onSubmit(value.trim())
            onClose()
          }}
        />
      </View>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Fork from a prompt
// ---------------------------------------------------------------------------

/** Pick an earlier prompt to branch the session from. */
export function ForkSheet({
  chatId,
  visible,
  onClose
}: {
  chatId: string
  visible: boolean
  onClose(): void
}) {
  const [messages, setMessages] = useState<ForkMessage[] | null>(null)
  useEffect(() => {
    if (!visible) {
      return
    }
    setMessages(null)
    let cancelled = false
    api.chat
      .forkMessages(chatId)
      .then((result) => {
        if (!cancelled) {
          setMessages([...result.messages].reverse())
        }
      })
      .catch((e) => {
        toast(errorText(e))
        onClose()
      })
    return () => {
      cancelled = true
    }
  }, [visible, chatId, onClose])
  return (
    <Sheet visible={visible} onClose={onClose} title="Fork from a prompt" scroll={false}>
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
        <Txt size="small" tone="muted">
          The chat continues on a new branch from before that prompt; its text returns to the message box.
        </Txt>
      </View>
      <FlatList
        style={{ maxHeight: 420 }}
        data={messages ?? []}
        keyExtractor={(item) => item.entryId}
        ItemSeparatorComponent={Divider}
        renderItem={({ item }) => (
          <Row
            title={item.text.replace(/\s+/g, ' ').trim().slice(0, 120) || '(empty prompt)'}
            onPress={() => {
              onClose()
              void useChats
                .getState()
                .forkAtEntry(chatId, item.entryId)
                .catch((e) => toast(`Could not fork: ${errorText(e)}`))
            }}
          />
        )}
        ListEmptyComponent={
          <Empty title={messages === null ? 'Loading…' : 'Nothing to fork from yet'} />
        }
      />
    </Sheet>
  )
}

/**
 * /tree: the session's branches. A linear chat stays flat; branches indent
 * and the one pi is on is marked. A prompt forks from before it.
 */
export function TreeSheet({ chatId, visible, onClose }: { chatId: string; visible: boolean; onClose(): void }) {
  const theme = useTheme()
  const [rows, setRows] = useState<TreeRow[] | null>(null)
  useEffect(() => {
    if (!visible) {
      return
    }
    setRows(null)
    let cancelled = false
    api.chat
      .tree(chatId)
      .then((result) => {
        if (!cancelled) {
          setRows(flattenSessionTree(result))
        }
      })
      .catch((e) => {
        toast(errorText(e))
        onClose()
      })
    return () => {
      cancelled = true
    }
  }, [visible, chatId, onClose])
  const branches = rows?.filter((row) => row.branchStart).length ?? 0
  return (
    <Sheet visible={visible} onClose={onClose} title="Session tree" scroll={false}>
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
        <Txt size="small" tone="muted">
          {branches > 0
            ? `${branches} branches. The one pi is on is highlighted; tap a prompt to fork from before it.`
            : 'Tap a prompt to continue on a new branch from before it.'}
        </Txt>
      </View>
      <FlatList
        style={{ maxHeight: 480 }}
        data={rows ?? []}
        keyExtractor={(row) => row.id}
        initialNumToRender={30}
        renderItem={({ item }) => (
          <Tap
            disabled={!item.forkable}
            label={`${item.role}: ${item.snippet}${item.leaf ? ', current position' : ''}${item.forkable ? '. Fork from here' : ''}`}
            onPress={() => {
              onClose()
              void useChats
                .getState()
                .forkAtEntry(chatId, item.id)
                .catch((e) => toast(`Could not fork: ${errorText(e)}`))
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm,
              minHeight: 40,
              paddingVertical: space.xs,
              paddingRight: space.lg,
              paddingLeft: space.lg + item.depth * 14,
              borderTopWidth: item.branchStart ? 1 : 0,
              borderTopColor: theme.border,
              opacity: item.active ? 1 : 0.62
            }}
          >
            <Mono size={11} tone={item.role === 'user' ? 'accent' : 'muted'} style={{ width: 64 }} numberOfLines={1}>
              {item.role}
            </Mono>
            <Txt size="small" tone={item.active ? 'text' : 'text2'} numberOfLines={1} style={{ flex: 1 }}>
              {item.snippet}
            </Txt>
            {item.leaf ? (
              <Mono size={11} tone="accent">
                here
              </Mono>
            ) : null}
          </Tap>
        )}
        ListEmptyComponent={<Empty title={rows === null ? 'Loading…' : 'Empty session'} />}
      />
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Image viewer
// ---------------------------------------------------------------------------

/**
 * Full-screen image. Tap switches between fitting the screen and actual
 * pixels (scroll around a screenshot to read it); Share saves or sends it.
 */
export function Lightbox({ uri, onClose }: { uri: string | null; onClose(): void }) {
  const insets = useSafeAreaInsets()
  const [actual, setActual] = useState(false)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    setActual(false)
    setSize(null)
    if (uri) {
      Image.getSize(uri, (width, height) => setSize({ width, height }), () => {})
    }
  }, [uri])
  const close = (): void => {
    setActual(false)
    onClose()
  }
  return (
    <Modal visible={uri !== null} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.94)' }}>
        {uri && actual && size ? (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ minHeight: '100%', justifyContent: 'center' }}>
            <ScrollView horizontal contentContainerStyle={{ minWidth: '100%', justifyContent: 'center' }}>
              <Tap label="Fit to screen" onPress={() => setActual(false)}>
                <Image source={{ uri }} style={{ width: size.width / PixelRatio.get(), height: size.height / PixelRatio.get() }} />
              </Tap>
            </ScrollView>
          </ScrollView>
        ) : uri ? (
          <Tap label="Show actual size" onPress={() => setActual(true)} style={{ flex: 1 }}>
            <Image source={{ uri }} style={{ flex: 1 }} resizeMode="contain" accessibilityLabel="Image, full screen" />
          </Tap>
        ) : null}
        <View style={{ position: 'absolute', top: insets.top + space.sm, right: space.sm, flexDirection: 'row', gap: space.xs }}>
          <IconButton
            icon={Share2}
            label="Share or save image"
            tone="onAccent"
            onPress={() => {
              if (uri) {
                void shareDataUri(uri).catch((e) => toast(`Could not share: ${errorText(e)}`))
              }
            }}
            style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
          />
          <IconButton icon={X} label="Close image" tone="onAccent" onPress={close} style={{ backgroundColor: 'rgba(0,0,0,0.5)' }} />
        </View>
        {size ? (
          <View style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + space.lg, alignItems: 'center' }} pointerEvents="none">
            <Mono size={12} style={{ color: '#a0a0a8' }}>
              {`${size.width}×${size.height} · tap for ${actual ? 'fit' : 'actual size'}`}
            </Mono>
          </View>
        ) : null}
      </View>
    </Modal>
  )
}
