import * as Clipboard from 'expo-clipboard'
import { Copy, FileX } from 'lucide-react-native'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Image, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import type { FileReadResult } from '../desktop'
import { Lightbox } from '../chat/sheets'
import { baseName } from '../lib/format'
import { highlightLines, languageOfPath, type Token, type TokenKind } from '../lib/highlight'
import type { ScreenProps } from '../nav'
import { api, errorText } from '../remote/api'
import { makeStyles, space, useTheme } from '../theme'
import { Button, Empty, IconButton, Mono, Pixel, Screen, Tap, toast, Txt } from '../ui'

const useStyles = makeStyles((t) => ({
  line: { flexDirection: 'row', paddingRight: space.md },
  gutter: { textAlign: 'right', paddingRight: space.sm, marginRight: space.sm },
  text: { flex: 1, color: t.text },
  note: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: t.border
  },
  loading: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm
  }
}))

interface LineItem {
  no: number
  tokens: Token[]
}

const LineRow = memo(function LineRow({
  no,
  tokens,
  gutterWidth,
  colors
}: {
  no: number
  tokens: Token[]
  gutterWidth: number
  colors: Record<TokenKind, string | undefined>
}) {
  const styles = useStyles()
  return (
    <View style={styles.line}>
      <Mono size={12} tone="muted" numberOfLines={1} style={[styles.gutter, { width: gutterWidth }]}>
        {no}
      </Mono>
      <Mono size={12.5} tone="text" selectable style={styles.text}>
        {tokens.length === 0
          ? ' '
          : tokens.map((token, i) =>
              token.kind === 'plain' ? (
                token.text
              ) : (
                <Text key={i} style={{ color: colors[token.kind] }}>
                  {token.text}
                </Text>
              )
            )}
      </Mono>
    </View>
  )
})

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i

/** An image file of the project: fitted, tap for full screen. */
function ImagePreview({ cwd, path }: { cwd: string; path: string }) {
  const [uri, setUri] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let cancelled = false
    api.files
      .readImage(cwd, path)
      .then((image) => !cancelled && setUri(`data:${image.mimeType};base64,${image.data}`))
      .catch((e: unknown) => !cancelled && setError(errorText(e)))
    return () => {
      cancelled = true
    }
  }, [cwd, path])
  if (error) {
    return <Empty icon={FileX} title="Could not show the image" detail={error} />
  }
  if (!uri) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Pixel tone="working" />
      </View>
    )
  }
  return (
    <>
      <Tap label="Open image full screen" onPress={() => setOpen(true)} style={{ flex: 1, margin: space.lg }}>
        <Image source={{ uri }} style={{ flex: 1 }} resizeMode="contain" accessibilityLabel={baseName(path)} />
      </Tap>
      <Lightbox uri={open ? uri : null} onClose={() => setOpen(false)} />
    </>
  )
}

const keyOf = (item: LineItem): string => String(item.no)

/** A text file of the project, read-only, with line numbers. */
export function FileScreen({ navigation, route }: ScreenProps<'File'>) {
  const { cwd, path } = route.params
  const styles = useStyles()
  const insets = useSafeAreaInsets()
  const [file, setFile] = useState<FileReadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)

  const load = useCallback(() => {
    const id = ++request.current
    setError(null)
    setFile(null)
    api.files
      .read(cwd, path)
      .then((result) => {
        if (request.current === id) {
          setFile(result)
        }
      })
      .catch((e: unknown) => {
        if (request.current === id) {
          setError(errorText(e))
        }
      })
  }, [cwd, path])

  useEffect(() => {
    load()
    return () => {
      request.current++
    }
  }, [load])

  const lines = useMemo<LineItem[]>(() => {
    if (!file || file.binary) {
      return []
    }
    const rows = highlightLines(file.content, languageOfPath(file.relativePath))
    if (rows.length > 1 && rows[rows.length - 1]!.length === 0 && file.content.endsWith('\n')) {
      rows.pop()
    }
    return rows.map((tokens, i) => ({ no: i + 1, tokens }))
  }, [file])
  const theme = useTheme()
  // Text-grade colors, as in the chat's code blocks.
  const colors = useMemo<Record<TokenKind, string | undefined>>(
    () => ({
      plain: undefined,
      comment: theme.muted,
      string: theme.success,
      keyword: theme.accent,
      number: theme.warning,
      added: theme.success,
      removed: theme.danger
    }),
    [theme]
  )

  // Room for the widest line number (a 12px mono digit is ~7.2px wide).
  const gutterWidth = Math.max(3, String(lines.length).length) * 7.5 + space.md + space.sm

  const renderItem = useCallback(
    ({ item }: { item: LineItem }) => (
      <LineRow no={item.no} tokens={item.tokens} gutterWidth={gutterWidth} colors={colors} />
    ),
    [gutterWidth, colors]
  )

  const copyAll = (): void => {
    if (!file) {
      return
    }
    Clipboard.setStringAsync(file.content).then(
      () => toast('Copied'),
      (e: unknown) => toast(errorText(e))
    )
  }

  const showsText = !!file && !file.binary
  return (
    <Screen
      title={baseName(file?.relativePath ?? path)}
      subtitle={file?.relativePath ?? path}
      onBack={() => navigation.goBack()}
      right={
        <IconButton icon={Copy} label="Copy file contents" onPress={copyAll} disabled={!showsText} />
      }
      bottomInset={false}
    >
      {error ? (
        <Empty
          icon={FileX}
          title="Could not open the file"
          detail={error}
          action={<Button title="Retry" onPress={load} />}
        />
      ) : !file ? (
        <View style={styles.loading}>
          <Pixel tone="working" />
          <Txt size="small" tone="muted">
            Loading…
          </Txt>
        </View>
      ) : file.binary && IMAGE_EXT.test(file.relativePath) ? (
        <ImagePreview cwd={cwd} path={path} />
      ) : file.binary ? (
        <Empty icon={FileX} title="Binary file" detail="This file cannot be shown as text." />
      ) : lines.length === 0 ? (
        <Empty title="Empty file" />
      ) : (
        <>
          {file.truncated ? (
            <View style={styles.note}>
              <Txt size="caption" tone="muted">
                The file is large; only its beginning is shown.
              </Txt>
            </View>
          ) : null}
          <FlatList
            data={lines}
            keyExtractor={keyOf}
            renderItem={renderItem}
            initialNumToRender={60}
            maxToRenderPerBatch={60}
            windowSize={7}
            contentContainerStyle={{ paddingTop: space.sm, paddingBottom: insets.bottom + space.lg }}
          />
        </>
      )}
    </Screen>
  )
}
