import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Clipboard from 'expo-clipboard'
import * as DocumentPicker from 'expo-document-picker'
import { File as LocalFile } from 'expo-file-system'
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import {
  ArrowUp,
  AtSign,
  Camera,
  ClipboardPaste,
  FileUp,
  ImagePlus,
  MousePointerClick,
  Plus,
  Slash,
  Square,
  SquareTerminal,
  X
} from 'lucide-react-native'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Image, StyleSheet, TextInput, View } from 'react-native'

import {
  filterSlashCommands,
  flattenSlashGroups,
  formatMention,
  fuzzyFilter,
  mentionTrigger,
  parseSlashSend,
  queueLength,
  slashQuery,
  thinkingLevelLabel,
  type ImageContent,
  type SlashCommandItem
} from '../desktop'
import { api, errorText } from '../remote/api'
import { useChats } from '../state/chats'
import { useConnection } from '../state/connection'
import { makeStyles, radius, space, TOUCH, useTheme, type Theme } from '../theme'
import { haptic, IconButton, Mono, Sheet, SheetAction, Tap, toast, Txt } from '../ui'

/** App commands that make sense on the phone; the rest need the computer. */
export const PHONE_COMMANDS = new Set([
  'model',
  'thinking',
  'new',
  'resume',
  'name',
  'session',
  'tree',
  'fork',
  'clone',
  'btw',
  'compact',
  'copy',
  'reload'
])

const MAX_IMAGES = 6
/** Longest edge sent to the model; larger photos are scaled down first. */
const MAX_IMAGE_EDGE = 1568
const MAX_SUGGESTIONS = 40

// Drafts survive leaving the chat and restarting the app.
const draftCache = new Map<string, string>()
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>()
const draftKey = (chatId: string): string => `pi-remote.draft.${chatId}`

function saveDraft(chatId: string, text: string): void {
  draftCache.set(chatId, text)
  const pending = draftTimers.get(chatId)
  if (pending) {
    clearTimeout(pending)
  }
  draftTimers.set(
    chatId,
    setTimeout(() => {
      draftTimers.delete(chatId)
      void (text ? AsyncStorage.setItem(draftKey(chatId), text) : AsyncStorage.removeItem(draftKey(chatId))).catch(
        () => {}
      )
    }, 600)
  )
}

// Project file lists for @-mentions, fetched once per folder per app run.
const fileCache = new Map<string, Promise<string[]>>()
function projectFiles(cwd: string): Promise<string[]> {
  let files = fileCache.get(cwd)
  if (!files) {
    files = api.files
      .list(cwd)
      .then((result) => result.files)
      .catch(() => {
        fileCache.delete(cwd)
        return []
      })
    fileCache.set(cwd, files)
  }
  return files
}

const useStyles = makeStyles((t: Theme) => ({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.border,
    backgroundColor: t.bg,
    paddingHorizontal: space.sm,
    paddingTop: space.sm
  },
  box: {
    backgroundColor: t.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.borderStrong
  },
  input: {
    color: t.text,
    fontSize: 16,
    lineHeight: 22,
    maxHeight: 148,
    minHeight: 44,
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: space.xs,
    textAlignVertical: 'top'
  },
  bar: { flexDirection: 'row', alignItems: 'center', paddingLeft: 2, paddingRight: space.xs, paddingBottom: space.xs },
  chip: {
    flexShrink: 1,
    minHeight: TOUCH,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderRadius: radius.sm
  },
  // 44 on screen; the hit slop below brings the touch target to 48.
  send: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    overflow: 'hidden'
  },
  suggestions: {
    maxHeight: 232,
    marginBottom: space.sm,
    backgroundColor: t.raised,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.borderStrong
  },
  suggestion: { minHeight: TOUCH, paddingHorizontal: space.md, paddingVertical: space.sm, justifyContent: 'center' },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, padding: space.sm, paddingBottom: 0 },
  thumb: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: t.codeBg },
  remove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: t.active,
    alignItems: 'center',
    justifyContent: 'center'
  },
  queue: {
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: t.surface,
    gap: space.xs
  },
  mode: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.sm, paddingBottom: space.xs }
}))

const SuggestionRow = memo(function SuggestionRow({
  title,
  detail,
  onPress
}: {
  title: string
  detail?: string
  onPress(): void
}) {
  const styles = useStyles()
  return (
    <Tap onPress={onPress} style={styles.suggestion}>
      <Mono size={14} tone="text" numberOfLines={1}>
        {title}
      </Mono>
      {detail ? (
        <Txt size="caption" tone="muted" numberOfLines={1}>
          {detail}
        </Txt>
      ) : null}
    </Tap>
  )
})

/** Messages sent mid-run, waiting in pi's queue until it delivers them. */
function QueueStrip({ chatId }: { chatId: string }) {
  const styles = useStyles()
  const queue = useChats((s) => s.chats[chatId]?.queue)
  if (queueLength(queue) === 0 || !queue) {
    return null
  }
  const rows = [
    ...queue.steering.map((text) => ({ tag: 'steer', text })),
    ...queue.followUp.map((text) => ({ tag: 'next', text }))
  ]
  return (
    <View style={styles.queue}>
      {rows.map((row, index) => (
        <View key={index} style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
          <Mono size={12} tone="warning">
            {row.tag}
          </Mono>
          <Txt size="small" tone="text2" numberOfLines={1} style={{ flex: 1 }}>
            {row.text}
          </Txt>
        </View>
      ))}
      <Tap
        onPress={() => void useChats.getState().clearQueue(chatId)}
        style={{ minHeight: TOUCH, justifyContent: 'center' }}
      >
        <Txt size="small" tone="accent">
          Take back to edit
        </Txt>
      </Tap>
    </View>
  )
}

export interface ComposerProps {
  chatId: string
  /** Run an app command (`/name foo`); false when it is not one. */
  onCommand(command: string, args: string): boolean
  onOpenModel(): void
  onOpenStats(): void
}

/**
 * The message box: text with `@` file mentions and `/` commands, photos,
 * `!command` shell runs, the model chip and the context readout. While pi
 * works, the send button stops it; text sent mid-run steers the run or waits
 * for it to end.
 */
export const Composer = memo(function Composer({ chatId, onCommand, onOpenModel, onOpenStats }: ComposerProps) {
  const styles = useStyles()
  const theme = useTheme()
  const status = useChats((s) => s.chats[chatId]?.status)
  const cwd = useChats((s) => s.chats[chatId]?.cwd ?? '')
  const model = useChats((s) => s.chats[chatId]?.model)
  const level = useChats((s) => s.chats[chatId]?.thinkingLevel)
  const commands = useChats((s) => s.chats[chatId]?.commands)
  const seed = useChats((s) => s.chats[chatId]?.composerSeed)
  const bashRunning = useChats((s) => s.chats[chatId]?.bashRunning === true)
  const percent = useChats((s) => s.chats[chatId]?.stats?.contextUsage?.percent)
  const hasMessages = useChats((s) => (s.chats[chatId]?.messages.length ?? 0) > 0)

  // A chat gets a new id on every app run; its session file is what lasts.
  const sessionPath = useChats((s) => s.chats[chatId]?.sessionPath)
  const draftId = sessionPath ?? chatId
  const [text, setTextState] = useState(() => draftCache.get(draftId) ?? '')
  const [cursor, setCursor] = useState(0)
  const [images, setImages] = useState<(ImageContent & { uri: string })[]>([])
  const [attachOpen, setAttachOpen] = useState(false)
  const [uploading, setUploading] = useState<string | null>(null)
  // What the sheet offers depends on the computer and the clipboard: looked up when it opens.
  const [computerUse, setComputerUse] = useState<boolean | null>(null)
  const [clipboardImage, setClipboardImage] = useState(false)
  useEffect(() => {
    if (!attachOpen) {
      return
    }
    let cancelled = false
    void Clipboard.hasImageAsync()
      .then((has) => !cancelled && setClipboardImage(has))
      .catch(() => {})
    void Promise.all([api.cua.permissions(), api.app.settings()])
      .then(([perms, settings]) => {
        if (!cancelled) {
          setComputerUse(perms.available ? settings.computerUse.enabled : null)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [attachOpen])
  const [queueMode, setQueueMode] = useState<'steer' | 'followUp'>('steer')
  const [files, setFiles] = useState<string[]>([])
  const input = useRef<TextInput>(null)
  const streaming = status === 'streaming'

  const setText = useCallback(
    (next: string) => {
      setTextState(next)
      saveDraft(draftId, next)
    },
    [draftId]
  )

  // Restore a draft written in an earlier app run.
  const textRef = useRef(text)
  textRef.current = text
  useEffect(() => {
    // The draft id changes once when a new chat gets its session file: what
    // is typed moves along.
    if (textRef.current) {
      saveDraft(draftId, textRef.current)
      return
    }
    if (draftCache.has(draftId)) {
      return
    }
    let cancelled = false
    void AsyncStorage.getItem(draftKey(draftId))
      .then((stored) => {
        if (!cancelled && stored && !draftCache.has(draftId) && !textRef.current) {
          draftCache.set(draftId, stored)
          setTextState(stored)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [draftId])

  // Text handed over by the app: a fork's prompt, review comments, a queue taken back.
  const seedNonce = seed?.nonce
  useEffect(() => {
    if (seed) {
      // Handed-over text joins what is already typed; an empty hand-over
      // (a retry that sends at once) clears the box.
      const current = draftCache.get(draftId) ?? ''
      setText(seed.text && current.trim() && current.trim() !== seed.text.trim() ? `${current.trimEnd()}\n\n${seed.text}` : seed.text)
      if (seed.text) {
        input.current?.focus()
      }
    }
    // Only a new nonce is a new hand-over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedNonce])

  const slash = slashQuery(text)
  const mention = slash === null ? mentionTrigger(text, Math.min(cursor, text.length)) : null
  const mentionActive = mention !== null && cwd !== ''
  useEffect(() => {
    if (!mentionActive) {
      return
    }
    let cancelled = false
    void projectFiles(cwd).then((list) => {
      if (!cancelled) {
        setFiles(list)
      }
    })
    return () => {
      cancelled = true
    }
  }, [mentionActive, cwd])

  const slashItems = useMemo<SlashCommandItem[]>(() => {
    if (slash === null) {
      return []
    }
    return flattenSlashGroups(filterSlashCommands(commands ?? [], slash, hasMessages, streaming))
      .filter((item) => item.source !== 'app' || PHONE_COMMANDS.has(item.name))
      .slice(0, MAX_SUGGESTIONS)
  }, [slash, commands, hasMessages, streaming])

  const mentionItems = useMemo(
    () => (mention ? fuzzyFilter(mention.query, files, (f) => f).slice(0, MAX_SUGGESTIONS) : []),
    [mention, files]
  )

  const pickSlash = (item: SlashCommandItem): void => {
    if (item.takesArgs || item.source !== 'app') {
      setText(`/${item.name} `)
      input.current?.focus()
      return
    }
    setText('')
    if (!onCommand(item.name, '')) {
      setText(`/${item.name} `)
    }
  }

  const pickMention = (path: string): void => {
    if (!mention) {
      return
    }
    const next = `${text.slice(0, mention.start)}${formatMention(path)} ${text.slice(mention.end)}`
    setText(next)
    input.current?.focus()
  }

  const addImages = async (source: 'library' | 'camera'): Promise<void> => {
    setAttachOpen(false)
    try {
      if (source === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync()
        if (!permission.granted) {
          toast('Camera access is needed to take a photo')
          return
        }
      }
      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              allowsMultipleSelection: true,
              selectionLimit: MAX_IMAGES,
              quality: 1
            })
      if (result.canceled) {
        return
      }
      const added: (ImageContent & { uri: string })[] = []
      for (const asset of result.assets.slice(0, MAX_IMAGES)) {
        const landscape = asset.width >= asset.height
        const scaled = await manipulateAsync(
          asset.uri,
          Math.max(asset.width, asset.height) > MAX_IMAGE_EDGE
            ? [{ resize: landscape ? { width: MAX_IMAGE_EDGE } : { height: MAX_IMAGE_EDGE } }]
            : [],
          { compress: 0.82, format: SaveFormat.JPEG, base64: true }
        )
        if (scaled.base64) {
          added.push({ type: 'image', data: scaled.base64, mimeType: 'image/jpeg', uri: scaled.uri })
        }
      }
      setImages((current) => [...current, ...added].slice(0, MAX_IMAGES))
    } catch (e) {
      toast(`Could not add the image: ${errorText(e)}`)
    }
  }

  /** Any file from the phone: stored on the computer, mentioned by path. */
  const sendFile = async (): Promise<void> => {
    setAttachOpen(false)
    try {
      const picked = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true })
      const asset = picked.canceled ? undefined : picked.assets[0]
      if (!asset) {
        return
      }
      if ((asset.size ?? 0) > 20 * 1024 * 1024) {
        toast('Files up to 20 MB can be sent')
        return
      }
      setUploading(asset.name)
      const data = await new LocalFile(asset.uri).base64()
      const { path } = await api.files.upload(asset.name, data)
      const current = textRef.current
      setText(`${current}${current && !current.endsWith(' ') ? ' ' : ''}${formatMention(path)} `)
      haptic('success')
      input.current?.focus()
    } catch (e) {
      toast(`Could not send the file: ${errorText(e)}`)
    } finally {
      setUploading(null)
    }
  }

  const pasteImage = async (): Promise<void> => {
    setAttachOpen(false)
    try {
      const image = await Clipboard.getImageAsync({ format: 'jpeg', jpegQuality: 0.85 })
      const match = image ? /^data:([^;]+);base64,(.+)$/.exec(image.data) : null
      if (!match) {
        toast('There is no image on the clipboard')
        return
      }
      setImages((current) =>
        [...current, { type: 'image' as const, data: match[2]!, mimeType: match[1]!, uri: image!.data }].slice(0, MAX_IMAGES)
      )
    } catch (e) {
      toast(`Could not paste: ${errorText(e)}`)
    }
  }

  const toggleComputerUse = (): void => {
    const next = !computerUse
    setAttachOpen(false)
    void api.cua
      .setEnabled(next)
      .then(() =>
        toast(next ? 'Computer use is on. pi can use it from its next start in a chat.' : 'Computer use is off.')
      )
      .catch((e) => toast(errorText(e)))
  }

  const insert = (prefix: string): void => {
    setAttachOpen(false)
    setText(text && !text.endsWith(' ') && prefix === '@' ? `${text} ${prefix}` : `${prefix}${prefix === '@' ? '' : text}`)
    setTimeout(() => input.current?.focus(), 250)
  }

  const submit = (): void => {
    const message = text.trim()
    const chats = useChats.getState()
    if (!message && images.length === 0) {
      return
    }
    if (uploading) {
      toast(`Sending ${uploading} first…`)
      return
    }
    if (useConnection.getState().phase !== 'online') {
      // Keep what was typed: it can be sent once the computer is back.
      haptic('warning')
      toast('Not connected to the computer. Your message is kept.')
      return
    }
    if (message.startsWith('!') && message.length > 1 && images.length === 0) {
      if (bashRunning) {
        toast('A command is still running. Stop it or wait for it to finish.')
        return
      }
      haptic()
      setText('')
      void chats.runBash(chatId, message.slice(1).trim())
      return
    }
    const parsed = images.length === 0 ? parseSlashSend(message) : null
    if (parsed && onCommand(parsed.command, parsed.args)) {
      setText('')
      return
    }
    haptic()
    const payload = images.length > 0 ? images.map(({ type, data, mimeType }) => ({ type, data, mimeType })) : undefined
    const sentText = message || 'See the attached image.'
    const sentImages = images
    setText('')
    setImages([])
    void chats.send(chatId, sentText, payload, streaming ? queueMode : 'prompt').catch((e) => {
      // The store hands the text back; the photos come back with it.
      setImages(sentImages)
      toast(`Could not send: ${errorText(e)}`)
    })
  }

  const stop = (): void => {
    haptic('warning')
    const chats = useChats.getState()
    void (bashRunning ? chats.abortBash(chatId) : chats.abort(chatId)).catch((e) => toast(errorText(e)))
  }

  const canSend = text.trim().length > 0 || images.length > 0
  const showStop = (streaming || bashRunning) && !canSend
  const suggestions = slash !== null ? slashItems.length : mentionItems.length

  return (
    <View style={styles.wrap}>
      <QueueStrip chatId={chatId} />
      {uploading ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.xs }} accessibilityLiveRegion="polite">
          <Mono size={12} tone="accent">↑</Mono>
          <Mono size={12} tone="muted" numberOfLines={1} style={{ flex: 1 }}>{`Sending ${uploading} to the computer…`}</Mono>
        </View>
      ) : null}
      {suggestions > 0 ? (
        <View style={styles.suggestions}>
          {slash !== null ? (
            <FlatList
              data={slashItems}
              keyExtractor={(item) => `${item.source}:${item.name}`}
              keyboardShouldPersistTaps="always"
              renderItem={({ item }) => (
                <SuggestionRow title={`/${item.name}`} detail={item.description} onPress={() => pickSlash(item)} />
              )}
            />
          ) : (
            <FlatList
              data={mentionItems}
              keyExtractor={(item) => item}
              keyboardShouldPersistTaps="always"
              renderItem={({ item }) => <SuggestionRow title={item} onPress={() => pickMention(item)} />}
            />
          )}
        </View>
      ) : null}
      <View style={styles.box}>
        {images.length > 0 ? (
          <View style={styles.thumbs}>
            {images.map((image, index) => (
              <View key={image.uri}>
                <Image source={{ uri: image.uri }} style={styles.thumb} accessibilityLabel={`Attached image ${index + 1}`} />
                <Tap
                  label={`Remove image ${index + 1}`}
                  hitSlop={12}
                  onPress={() => setImages((current) => current.filter((_, i) => i !== index))}
                  style={styles.remove}
                >
                  <X size={13} color={theme.text} />
                </Tap>
              </View>
            ))}
          </View>
        ) : null}
        <TextInput
          ref={input}
          value={text}
          onChangeText={setText}
          onSelectionChange={(e) => setCursor(e.nativeEvent.selection.end)}
          multiline
          placeholder={streaming ? 'Steer pi, or queue what comes next' : 'Ask pi…   / commands   @ files   ! shell'}
          placeholderTextColor={theme.muted}
          selectionColor={theme.accent}
          cursorColor={theme.accent}
          accessibilityLabel="Message to pi"
          style={styles.input}
          testID="composer-input"
        />
        {streaming && canSend ? (
          <View style={styles.mode} accessibilityRole="radiogroup">
            {(['steer', 'followUp'] as const).map((mode) => {
              const selected = queueMode === mode
              return (
                <Tap
                  key={mode}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => setQueueMode(mode)}
                  style={{
                    minHeight: TOUCH,
                    paddingHorizontal: space.md,
                    justifyContent: 'center',
                    borderRadius: radius.sm,
                    backgroundColor: selected ? theme.active : 'transparent'
                  }}
                >
                  <Mono size={12} tone={selected ? 'text' : 'muted'}>
                    {mode === 'steer' ? 'steer · after this step' : 'next · when the run ends'}
                  </Mono>
                </Tap>
              )
            })}
          </View>
        ) : null}
        <View style={styles.bar}>
          <IconButton icon={Plus} label="Attach or insert" onPress={() => setAttachOpen(true)} />
          <Tap onPress={onOpenModel} style={styles.chip} accessibilityLabel={`Model: ${model?.name ?? 'none'}. Change model`}>
            <Mono size={12} tone="text2" numberOfLines={1}>
              {model ? model.name || model.id : 'model'}
              {level && level !== 'off' ? ` · ${thinkingLevelLabel(level).toLowerCase()}` : ''}
            </Mono>
          </Tap>
          <View style={{ flex: 1 }} />
          {typeof percent === 'number' && percent >= 1 ? (
            <Tap onPress={onOpenStats} style={styles.chip} accessibilityLabel={`Context ${Math.round(percent)} percent used. Session details`}>
              <Mono size={12} tone={percent >= 85 ? 'warning' : 'muted'}>{`${Math.round(percent)}%`}</Mono>
            </Tap>
          ) : null}
          <View style={[styles.send, { backgroundColor: showStop ? theme.dangerSoft : canSend ? theme.accent : theme.active }]}>
            <Tap
              testID="composer-send"
              label={showStop ? 'Stop pi' : 'Send'}
              hitSlop={4}
              disabled={!showStop && !canSend}
              onPress={showStop ? stop : submit}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
            >
              {showStop ? (
                <Square size={15} color={theme.danger} fill={theme.danger} />
              ) : (
                <ArrowUp size={19} color={canSend ? theme.onAccent : theme.muted} strokeWidth={2.2} />
              )}
            </Tap>
          </View>
        </View>
      </View>
      <Sheet visible={attachOpen} onClose={() => setAttachOpen(false)} title="Add to the message">
        <SheetAction icon={ImagePlus} title="Photo library" onPress={() => void addImages('library')} />
        <SheetAction icon={Camera} title="Take a photo" onPress={() => void addImages('camera')} />
        {clipboardImage ? (
          <SheetAction icon={ClipboardPaste} title="Paste image" detail="The image on the clipboard" onPress={() => void pasteImage()} />
        ) : null}
        <SheetAction
          icon={FileUp}
          title="Send a file"
          detail="Any file up to 20 MB: stored on the computer, pi reads it"
          onPress={() => void sendFile()}
        />
        <SheetAction icon={AtSign} title="Mention a file" detail="Search the project's files" onPress={() => insert('@')} />
        <SheetAction icon={Slash} title="Command" detail="pi's skills, prompts and app commands" onPress={() => insert('/')} />
        <SheetAction
          icon={SquareTerminal}
          title="Run a shell command"
          detail="Runs on the computer; its output joins the next prompt"
          onPress={() => insert('!')}
        />
        {computerUse !== null ? (
          <SheetAction
            icon={MousePointerClick}
            title={computerUse ? 'Turn computer use off' : 'Turn computer use on'}
            detail="Lets pi operate the Mac's apps; new and restarted chats pick it up"
            selected={computerUse}
            onPress={toggleComputerUse}
          />
        ) : null}
      </Sheet>
    </View>
  )
})
