import { CornerLeftUp, Folder } from 'lucide-react-native'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'

import type { RemoteDirListing } from '../desktop'
import { resolveFolder } from '../lib/folder-pick'
import { tildePath } from '../lib/format'
import type { ScreenProps } from '../nav'
import { api, errorText } from '../remote/api'
import { useData } from '../state/data'
import { makeStyles, space, TOUCH, useTheme } from '../theme'
import { Button, Empty, Field, Mono, Pixel, Screen, Tap, toast, Txt } from '../ui'

const useStyles = makeStyles((t) => ({
  flex: { flex: 1 },
  go: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: t.border
  },
  row: {
    minHeight: TOUCH + 4,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md
  },
  name: { flex: 1 },
  note: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.lg },
  bar: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    gap: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.border,
    backgroundColor: t.bg
  },
  barNote: { flexDirection: 'row', alignItems: 'center', gap: space.sm }
}))

/** Child path with the separator the computer's own paths use. */
function join(parent: string, name: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`
}

const FolderRow = memo(function FolderRow({
  name,
  onPress
}: {
  name: string
  onPress(name: string): void
}) {
  const styles = useStyles()
  const theme = useTheme()
  return (
    <Tap onPress={() => onPress(name)} accessibilityLabel={`Open folder ${name}`} style={styles.row}>
      <Folder size={19} color={theme.text2} strokeWidth={1.75} />
      <Txt numberOfLines={1} style={styles.name}>
        {name}
      </Txt>
    </Tap>
  )
})

/** Browse folders on the computer and choose one. */
export function FolderPickerScreen({ navigation, route }: ScreenProps<'FolderPicker'>) {
  const styles = useStyles()
  const theme = useTheme()
  const homeDir = useData((s) => s.appInfo?.homeDir)
  const [listing, setListing] = useState<RemoteDirListing | null>(null)
  const [busy, setBusy] = useState(true)
  const [failed, setFailed] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const chosen = useRef(false)
  const seq = useRef(0)

  const load = useCallback((path?: string) => {
    const mine = ++seq.current
    setBusy(true)
    api.app
      .listDirs(path)
      .then((next) => {
        if (mine !== seq.current) {
          return
        }
        setListing(next)
        setTyped(next.path)
        setFailed(null)
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) {
          return
        }
        const text = errorText(e)
        // Stay where we are; only the very first load has nothing to show.
        setFailed(text)
        toast(/not connected/i.test(text) ? text : 'That folder cannot be opened')
      })
      .finally(() => {
        if (mine === seq.current) {
          setBusy(false)
        }
      })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Leaving without a choice answers the caller with null.
  useEffect(
    () =>
      navigation.addListener('beforeRemove', () => {
        if (!chosen.current) {
          resolveFolder(null)
        }
      }),
    [navigation]
  )

  const enter = useCallback(
    (name: string) => {
      if (listing) {
        load(join(listing.path, name))
      }
    },
    [listing, load]
  )

  const go = useCallback(() => {
    const path = typed.trim()
    if (path) {
      load(path)
    }
  }, [typed, load])

  const choose = useCallback(() => {
    if (!listing) {
      return
    }
    chosen.current = true
    resolveFolder(listing.path)
    navigation.goBack()
  }, [listing, navigation])

  const renderItem = useCallback(
    ({ item }: { item: string }) => <FolderRow name={item} onPress={enter} />,
    [enter]
  )

  const parent = listing?.parent ?? null

  return (
    <Screen
      title={route.params.title}
      subtitle={listing ? tildePath(listing.path, homeDir) : undefined}
      onBack={() => navigation.goBack()}
    >
      <View style={styles.go}>
        <Field
          value={typed}
          onChangeText={setTyped}
          onSubmitEditing={go}
          placeholder="/absolute/path"
          accessibilityLabel="Folder path on the computer"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          style={styles.flex}
        />
        <Button title="Go" onPress={go} disabled={typed.trim().length === 0} />
      </View>

      {listing ? (
        <FlatList
          style={styles.flex}
          data={listing.dirs}
          keyExtractor={(name) => name}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 24 }}
          ListHeaderComponent={
            <>
              {busy ? (
                <View style={styles.note}>
                  <Pixel tone="working" />
                  <Mono tone="muted">Loading…</Mono>
                </View>
              ) : null}
              {parent !== null ? (
                <Tap
                  onPress={() => load(parent)}
                  accessibilityLabel="Go to the parent folder"
                  style={styles.row}
                >
                  <CornerLeftUp size={19} color={theme.muted} strokeWidth={1.75} />
                  <Mono size={14} tone="text2" style={styles.name}>
                    ..
                  </Mono>
                </Tap>
              ) : null}
            </>
          }
          ListEmptyComponent={
            <View style={styles.note}>
              <Mono tone="muted">no folders inside</Mono>
            </View>
          }
        />
      ) : busy ? (
        <View style={[styles.note, styles.flex, { alignItems: 'flex-start' }]}>
          <Pixel tone="working" />
          <Mono tone="muted">Loading…</Mono>
        </View>
      ) : (
        <Empty
          title="Could not list folders"
          detail={failed ?? undefined}
          action={<Button title="Retry" onPress={() => load()} />}
        />
      )}

      <View style={styles.bar}>
        {listing?.repo ? (
          <View style={styles.barNote}>
            <Pixel tone="idle" size={6} />
            <Mono size={12} tone="muted">
              git repository
            </Mono>
          </View>
        ) : null}
        <Button title="Choose this folder" kind="primary" onPress={choose} disabled={!listing} />
      </View>
    </Screen>
  )
}
