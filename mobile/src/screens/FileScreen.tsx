import * as Clipboard from 'expo-clipboard'
import { Copy, FileX } from 'lucide-react-native'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import type { FileReadResult } from '../desktop'
import { baseName } from '../lib/format'
import type { ScreenProps } from '../nav'
import { api, errorText } from '../remote/api'
import { makeStyles, space } from '../theme'
import { Button, Empty, IconButton, Mono, Pixel, Screen, toast, Txt } from '../ui'

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
  text: string
}

const LineRow = memo(function LineRow({
  no,
  text,
  gutterWidth
}: {
  no: number
  text: string
  gutterWidth: number
}) {
  const styles = useStyles()
  return (
    <View style={styles.line}>
      <Mono size={12} tone="muted" numberOfLines={1} style={[styles.gutter, { width: gutterWidth }]}>
        {no}
      </Mono>
      <Mono size={12.5} tone="text" selectable style={styles.text}>
        {text || ' '}
      </Mono>
    </View>
  )
})

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
    const parts = file.content.split('\n')
    if (parts.length > 1 && parts[parts.length - 1] === '') {
      parts.pop()
    }
    return parts.map((text, i) => ({ no: i + 1, text: text.replace(/\r$/, '') }))
  }, [file])

  // Room for the widest line number (a 12px mono digit is ~7.2px wide).
  const gutterWidth = Math.max(3, String(lines.length).length) * 7.5 + space.md + space.sm

  const renderItem = useCallback(
    ({ item }: { item: LineItem }) => (
      <LineRow no={item.no} text={item.text} gutterWidth={gutterWidth} />
    ),
    [gutterWidth]
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
