import { randomUUID } from 'expo-crypto'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  GitBranch,
  MoreHorizontal,
  RefreshCw,
  ScanSearch,
  Undo2
} from 'lucide-react-native'
import { usePreventRemove } from '@react-navigation/native'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Keyboard, KeyboardAvoidingView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import {
  anchorForLine,
  countChanges,
  diffFileForUntracked,
  parseUnifiedDiff,
  reviewPrompt,
  type DiffFile,
  type GitActionResult,
  type PatchLine,
  type RepoDiffResult,
  type Model,
  type ReviewComment
} from '../desktop'
import { ReviewSheet } from '../chat/sheets'
import type { ScreenProps } from '../nav'
import { api, errorText } from '../remote/api'
import { useChats } from '../state/chats'
import { makeStyles, radius, space, TOUCH, useTheme } from '../theme'
import {
  Button,
  confirm,
  Empty,
  Field,
  haptic,
  IconButton,
  Mono,
  Pixel,
  Screen,
  Sheet,
  SheetAction,
  Tap,
  toast,
  Txt
} from '../ui'

/** Files with more diff lines than this start collapsed. */
const COLLAPSE_LINES = 400

/** A comment pinned to one diff line; `key` is the line's `hunk:line` index. */
type PinnedComment = ReviewComment & { key: string }

type DiffRow =
  | {
      kind: 'file'
      key: string
      path: string
      status: string
      added: number
      deleted: number
      collapsed: boolean
    }
  | { kind: 'binary'; key: string }
  | { kind: 'hunk'; key: string; header: string }
  | { kind: 'line'; key: string; path: string; anchor: string; line: PatchLine }
  | { kind: 'note'; key: string; comment: PinnedComment }

type LineRowData = Extract<DiffRow, { kind: 'line' }>

interface FileEntry {
  file: DiffFile
  added: number
  deleted: number
  lineCount: number
  /** Hunk and line rows, built once per load so the row memo holds. */
  body: DiffRow[]
}

function buildEntries(files: DiffFile[]): FileEntry[] {
  return files.map((file) => {
    const { added, deleted } = countChanges(file)
    const body: DiffRow[] = []
    let lineCount = 0
    file.hunks.forEach((hunk, i) => {
      body.push({ kind: 'hunk', key: `h:${file.path}:${i}`, header: hunk.header })
      hunk.lines.forEach((line, j) => {
        lineCount++
        body.push({
          kind: 'line',
          key: `l:${file.path}:${i}:${j}`,
          path: file.path,
          anchor: `${i}:${j}`,
          line
        })
      })
    })
    return { file, added, deleted, lineCount, body }
  })
}

const useStyles = makeStyles((t) => ({
  loading: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm
  },
  summary: {
    minHeight: TOUCH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: t.border
  },
  reviewing: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingRight: space.sm },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: t.surface,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: t.border,
    marginTop: space.sm
  },
  fileTap: {
    flex: 1,
    minHeight: TOUCH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.md,
    paddingVertical: space.sm
  },
  fileMeta: { flexDirection: 'row', gap: space.sm, marginTop: 2 },
  hunk: { paddingHorizontal: space.md, paddingVertical: space.xs, backgroundColor: t.codeBg },
  line: { flexDirection: 'row', paddingRight: space.sm },
  added: { backgroundColor: t.successSoft },
  removed: { backgroundColor: t.dangerSoft },
  lineNo: { width: 32, textAlign: 'right' },
  marker: { width: 18, textAlign: 'center' },
  lineText: { flex: 1 },
  note: {
    marginLeft: space.md,
    marginRight: space.sm,
    marginVertical: space.xs,
    borderLeftWidth: 3,
    borderRadius: radius.sm,
    backgroundColor: t.surface,
    overflow: 'hidden'
  },
  noteTap: { minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: space.md, paddingVertical: space.sm },
  binary: { paddingHorizontal: space.lg, paddingVertical: space.md },
  bar: {
    borderTopWidth: 1,
    borderTopColor: t.border,
    backgroundColor: t.bg,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    gap: space.sm
  },
  barRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  sendComments: {
    borderLeftWidth: 3,
    borderLeftColor: t.warning,
    borderRadius: radius.md,
    backgroundColor: t.warningSoft,
    overflow: 'hidden'
  },
  sendCommentsTap: { minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: space.md },
  sheetBody: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.md },
  quoted: { backgroundColor: t.codeBg, borderRadius: radius.sm, padding: space.sm }
}))

function Stats({ added, deleted, size = 12 }: { added: number; deleted: number; size?: number }) {
  return (
    <Mono size={size} tone="muted">
      <Mono size={size} tone="success">
        +{added}
      </Mono>{' '}
      <Mono size={size} tone="danger">
        −{deleted}
      </Mono>
    </Mono>
  )
}

const FileRow = memo(function FileRow({
  path,
  status,
  added,
  deleted,
  collapsed,
  onToggle,
  onMenu
}: {
  path: string
  status: string
  added: number
  deleted: number
  collapsed: boolean
  onToggle(path: string): void
  onMenu(path: string): void
}) {
  const styles = useStyles()
  const theme = useTheme()
  const Chevron = collapsed ? ChevronRight : ChevronDown
  return (
    <View style={styles.file}>
      <Tap
        style={styles.fileTap}
        onPress={() => onToggle(path)}
        label={`${path}, ${status}. ${collapsed ? 'Expand' : 'Collapse'}`}
        accessibilityState={{ expanded: !collapsed }}
      >
        <Chevron size={18} color={theme.muted} strokeWidth={1.75} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Mono size={13} tone="text" weight="medium" numberOfLines={2} ellipsizeMode="head">
            {path}
          </Mono>
          <View style={styles.fileMeta}>
            <Mono size={12} tone="muted">
              {status}
            </Mono>
            <Stats added={added} deleted={deleted} />
          </View>
        </View>
      </Tap>
      <IconButton icon={MoreHorizontal} label={`Actions for ${path}`} onPress={() => onMenu(path)} />
    </View>
  )
})

const HunkRow = memo(function HunkRow({ header }: { header: string }) {
  const styles = useStyles()
  return (
    <View style={styles.hunk}>
      <Mono size={12} tone="muted" numberOfLines={1}>
        {header}
      </Mono>
    </View>
  )
})

const LineRow = memo(function LineRow({
  row,
  onPress
}: {
  row: LineRowData
  onPress(row: LineRowData): void
}) {
  const styles = useStyles()
  const { line } = row
  const add = line.type === 'add'
  const del = line.type === 'del'
  return (
    <Tap
      style={[styles.line, add ? styles.added : del ? styles.removed : null]}
      // A long press, so scrolling a diff never opens the comment sheet.
      onLongPress={() => onPress(row)}
      delayLongPress={300}
      accessibilityHint="Long press to comment on this line"
    >
      <Mono size={12} tone="muted" numberOfLines={1} style={styles.lineNo}>
        {line.oldNo ?? ''}
      </Mono>
      <Mono size={12} tone="muted" numberOfLines={1} style={styles.lineNo}>
        {line.newNo ?? ''}
      </Mono>
      <Mono size={12.5} tone={add ? 'success' : del ? 'danger' : 'muted'} style={styles.marker}>
        {add ? '+' : del ? '−' : ' '}
      </Mono>
      <Mono size={12.5} tone="text" style={styles.lineText}>
        {line.text || ' '}
      </Mono>
    </Tap>
  )
})

const NoteRow = memo(function NoteRow({
  comment,
  onPress
}: {
  comment: PinnedComment
  onPress(comment: PinnedComment): void
}) {
  const styles = useStyles()
  const theme = useTheme()
  const fromPi = comment.author === 'pi'
  return (
    <View style={[styles.note, { borderLeftColor: fromPi ? theme.accent : theme.warning }]}>
      <Tap
        style={styles.noteTap}
        onPress={() => onPress(comment)}
        accessibilityHint="Delete this comment"
      >
        {fromPi ? (
          <Mono size={12} tone="accent" weight="medium">
            pi
          </Mono>
        ) : null}
        <Txt size="small">{comment.text}</Txt>
      </Tap>
    </View>
  )
})

const rowKey = (row: DiffRow): string => row.key

/** Working-tree changes of a project: read, comment, review, commit, push. */
export function DiffScreen({ navigation, route }: ScreenProps<'Diff'>) {
  const { cwd, chatId } = route.params
  const styles = useStyles()
  const insets = useSafeAreaInsets()

  const [result, setResult] = useState<RepoDiffResult | null>(null)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [comments, setComments] = useState<PinnedComment[]>([])
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const [target, setTarget] = useState<LineRowData | null>(null)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [reviewMenu, setReviewMenu] = useState(false)

  const mounted = useRef(true)
  const request = useRef(0)
  /** Paths already shown once: only new large files are collapsed on a reload. */
  const seen = useRef(new Set<string>())
  const entriesRef = useRef(entries)
  entriesRef.current = entries

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    const id = ++request.current
    try {
      const next = await api.diff.status(cwd)
      if (!mounted.current || request.current !== id) {
        return
      }
      const built = buildEntries([
        ...parseUnifiedDiff(next.diffText),
        ...next.untracked.map((u) => diffFileForUntracked(u.path, u.content))
      ])
      const large = built.filter(
        (entry) => !seen.current.has(entry.file.path) && entry.lineCount > COLLAPSE_LINES
      )
      for (const entry of built) {
        seen.current.add(entry.file.path)
      }
      if (large.length > 0) {
        setCollapsed((prev) => new Set([...prev, ...large.map((entry) => entry.file.path)]))
      }
      // The diff moved under the comments: each follows its line (found by
      // its text, nearest to where it was); one whose line is gone is dropped.
      setComments((prev) => {
        let changed = false
        const kept: PinnedComment[] = []
        for (const comment of prev) {
          const file = built.find((entry) => entry.file.path === comment.path)?.file
          const [hunk, line] = comment.key.split(':').map(Number)
          const here = file?.hunks[hunk ?? -1]?.lines[line ?? -1]
          if (here && (!comment.lineText || here.text === comment.lineText)) {
            kept.push(comment)
            continue
          }
          changed = true
          if (!file || !comment.lineText) {
            continue
          }
          let best: { key: string; no: number | undefined; distance: number } | null = null
          file.hunks.forEach((h, i) =>
            h.lines.forEach((l, j) => {
              if (l.text !== comment.lineText) {
                return
              }
              const no = l.newNo ?? l.oldNo
              const distance = Math.abs((no ?? 0) - (comment.line ?? 0))
              if (!best || distance < best.distance) {
                best = { key: `${i}:${j}`, no, distance }
              }
            })
          )
          const found = best as { key: string; no: number | undefined } | null
          if (found) {
            kept.push({ ...comment, key: found.key, ...(found.no !== undefined ? { line: found.no } : {}) })
          }
        }
        return changed ? kept : prev
      })
      setEntries(built)
      setResult(next)
      setError(null)
    } catch (e) {
      if (mounted.current && request.current === id) {
        setError(errorText(e))
      }
    }
  }, [cwd])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback(() => {
    setPulling(true)
    void load().finally(() => {
      if (mounted.current) {
        setPulling(false)
      }
    })
  }, [load])

  const rows = useMemo<DiffRow[]>(() => {
    const notes = new Map<string, PinnedComment[]>()
    for (const comment of comments) {
      const at = `${comment.path}\n${comment.key}`
      const list = notes.get(at)
      if (list) {
        list.push(comment)
      } else {
        notes.set(at, [comment])
      }
    }
    const out: DiffRow[] = []
    for (const entry of entries) {
      const { file } = entry
      const isCollapsed = collapsed.has(file.path)
      out.push({
        kind: 'file',
        key: `f:${file.path}`,
        path: file.path,
        status: file.status,
        added: entry.added,
        deleted: entry.deleted,
        collapsed: isCollapsed
      })
      if (isCollapsed) {
        continue
      }
      if (file.isBinary) {
        out.push({ kind: 'binary', key: `b:${file.path}` })
        continue
      }
      for (const row of entry.body) {
        out.push(row)
        if (row.kind === 'line' && notes.size > 0) {
          for (const comment of notes.get(`${row.path}\n${row.anchor}`) ?? []) {
            out.push({ kind: 'note', key: `n:${comment.id}`, comment })
          }
        }
      }
    }
    return out
  }, [entries, collapsed, comments])

  const totals = useMemo(() => {
    let added = 0
    let deleted = 0
    for (const entry of entries) {
      added += entry.added
      deleted += entry.deleted
    }
    return { added, deleted }
  }, [entries])

  const toggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) {
        next.add(path)
      }
      return next
    })
  }, [])

  const openMenu = useCallback((path: string) => setMenuPath(path), [])

  const openComment = useCallback((row: LineRowData) => {
    setDraft('')
    setTarget(row)
  }, [])

  const removeComment = useCallback((comment: PinnedComment) => {
    void confirm({
      title: comment.author === 'pi' ? "Delete pi's remark?" : 'Delete this comment?',
      message: comment.text.slice(0, 200),
      action: 'Delete',
      danger: true
    }).then((yes) => {
      if (yes) {
        setComments((prev) => prev.filter((c) => c.id !== comment.id))
      }
    })
  }, [])

  const addComment = (): void => {
    const text = draft.trim()
    if (!target || !text) {
      return
    }
    setComments((prev) => [
      ...prev,
      {
        id: randomUUID(),
        key: target.anchor,
        path: target.path,
        line: target.line.newNo ?? target.line.oldNo,
        lineText: target.line.text,
        text
      }
    ])
    haptic('tap')
    setTarget(null)
    setDraft('')
  }

  const discard = async (path: string): Promise<void> => {
    setMenuPath(null)
    const entry = entriesRef.current.find((e) => e.file.path === path)
    const untracked = entry?.file.status === 'added'
    const yes = await confirm({
      title: 'Discard changes?',
      message: untracked
        ? `${path} is moved to the Trash on the computer.`
        : `${path} is restored to the last commit. This cannot be undone.`,
      action: 'Discard',
      danger: true
    })
    if (!yes) {
      return
    }
    try {
      const outcome = await api.diff.discard(cwd, path)
      toast(outcome.ok ? outcome.message : `Discard failed: ${outcome.message}`)
      if (outcome.ok) {
        setComments((prev) => prev.filter((c) => c.path !== path))
      }
    } catch (e) {
      toast(errorText(e))
    }
    void load()
  }

  const gitAction = async (
    kind: 'commit' | 'push',
    run: () => Promise<GitActionResult>
  ): Promise<boolean> => {
    if (busy) {
      return false
    }
    setBusy(kind)
    let ok = false
    try {
      const outcome = await run()
      ok = outcome.ok
      const label = kind === 'commit' ? 'Commit' : 'Push'
      toast(outcome.ok ? outcome.message : `${label} failed: ${outcome.message}`)
      if (outcome.ok) {
        haptic('success')
      }
    } catch (e) {
      toast(errorText(e))
    }
    if (mounted.current) {
      setBusy(null)
    }
    return ok
  }

  const commit = async (): Promise<void> => {
    const text = message.trim()
    if (!text) {
      return
    }
    Keyboard.dismiss()
    if ((await gitAction('commit', () => api.diff.commit(cwd, text))) && mounted.current) {
      setMessage('')
      setComments([])
      void load()
    }
  }

  const push = (): void => {
    void gitAction('push', () => api.diff.push(cwd))
  }

  // With the chat's model or another one picked in the Review sheet.
  const review = async (picked: Model | null): Promise<void> => {
    if (reviewing) {
      return
    }
    const model = picked ? { provider: picked.provider, modelId: picked.id } : undefined
    setReviewing(true)
    try {
      const remarks = await api.diff.review(cwd, model)
      if (!mounted.current) {
        return
      }
      if (remarks === null) {
        toast("pi's reply was not a list of comments")
        return
      }
      const placed: PinnedComment[] = []
      for (const remark of remarks) {
        const file = entriesRef.current.find((e) => e.file.path === remark.path)?.file
        const anchor = file ? anchorForLine(file, remark.line) : null
        if (!file || !anchor) {
          continue
        }
        placed.push({
          id: randomUUID(),
          key: anchor.key,
          path: file.path,
          line: anchor.exact ? anchor.line : remark.line,
          lineText: anchor.exact ? anchor.lineText : '',
          text:
            !anchor.exact && remark.line !== undefined
              ? `Line ${remark.line}: ${remark.comment}`
              : remark.comment,
          author: 'pi'
        })
      }
      // A new pass replaces pi's earlier remarks; yours stay.
      setComments((prev) => [...prev.filter((c) => c.author !== 'pi'), ...placed])
      if (placed.length > 0) {
        setCollapsed((prev) => {
          const next = new Set(prev)
          for (const comment of placed) {
            next.delete(comment.path)
          }
          return next
        })
      }
      toast(
        placed.length === 0
          ? 'pi found nothing to flag'
          : `${placed.length} ${placed.length === 1 ? 'remark' : 'remarks'} from pi`
      )
    } catch (e) {
      if (mounted.current) {
        toast(errorText(e))
      }
    } finally {
      if (mounted.current) {
        setReviewing(false)
      }
    }
  }

  // Choose the model first when the chat has others to offer.
  const startReview = (): void => {
    const chat = chatId ? useChats.getState().chats[chatId] : undefined
    const current = chat?.model ?? null
    const others = (chat?.models ?? []).filter(
      (m) => !(current && m.provider === current.provider && m.id === current.id)
    )
    if (others.length > 0) {
      setReviewMenu(true)
    } else {
      void review(current)
    }
  }

  const mine = useMemo(() => comments.filter((c) => c.author !== 'pi'), [comments])
  // Back would throw away what was typed here: ask first.
  const leaving = useRef(false)
  usePreventRemove(mine.length > 0 || message.trim() !== '', ({ data }) => {
    if (leaving.current) {
      navigation.dispatch(data.action)
      return
    }
    void confirm({
      title: 'Discard your comments?',
      message: 'Your line comments and the commit message have not been sent.',
      action: 'Discard',
      danger: true
    }).then((ok) => {
      if (ok) {
        leaving.current = true
        navigation.dispatch(data.action)
      }
    })
  })

  const sendComments = (): void => {
    if (!chatId || mine.length === 0) {
      return
    }
    useChats.getState().seedComposer(chatId, reviewPrompt(mine))
    toast(mine.length === 1 ? 'Comment added to the composer' : 'Comments added to the composer')
    leaving.current = true
    navigation.goBack()
  }

  const renderItem = useCallback(
    ({ item }: { item: DiffRow }) => {
      switch (item.kind) {
        case 'file':
          return (
            <FileRow
              path={item.path}
              status={item.status}
              added={item.added}
              deleted={item.deleted}
              collapsed={item.collapsed}
              onToggle={toggle}
              onMenu={openMenu}
            />
          )
        case 'hunk':
          return <HunkRow header={item.header} />
        case 'line':
          return <LineRow row={item} onPress={openComment} />
        case 'note':
          return <NoteRow comment={item.comment} onPress={removeComment} />
        case 'binary':
          return (
            <View style={styles.binary}>
              <Txt size="small" tone="muted">
                Binary file
              </Txt>
            </View>
          )
      }
    },
    [toggle, openMenu, openComment, removeComment, styles]
  )

  const menuEntry = menuPath ? entries.find((e) => e.file.path === menuPath) : undefined
  const targetLine = target ? (target.line.newNo ?? target.line.oldNo) : undefined
  const isRepo = !!result?.isRepo

  return (
    <Screen
      title="Changes"
      subtitle={result?.branch}
      onBack={() => navigation.goBack()}
      right={<IconButton icon={RefreshCw} label="Refresh" onPress={refresh} />}
      bottomInset={false}
    >
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        {!result && error ? (
          <Empty
            icon={GitBranch}
            title="Could not load the changes"
            detail={error}
            action={<Button title="Retry" onPress={() => void load()} />}
          />
        ) : !result ? (
          <View style={styles.loading}>
            <Pixel tone="working" />
            <Txt size="small" tone="muted">
              Loading…
            </Txt>
          </View>
        ) : !isRepo ? (
          <Empty
            icon={GitBranch}
            title="Not a git repository"
            detail="This folder has no repository, so there are no changes to show."
          />
        ) : (
          <>
            {entries.length > 0 ? (
              <View style={styles.summary}>
                <Mono size={13} tone="text2" style={{ flex: 1 }} numberOfLines={1}>
                  {entries.length} {entries.length === 1 ? 'file' : 'files'}
                  {'  '}
                  <Stats added={totals.added} deleted={totals.deleted} size={13} />
                </Mono>
                {!chatId ? null : reviewing ? (
                  <View style={styles.reviewing}>
                    <Pixel tone="working" />
                    <Txt size="small" tone="accent">
                      pi is reviewing…
                    </Txt>
                  </View>
                ) : (
                  <Button title="Review" kind="ghost" icon={ScanSearch} onPress={startReview} />
                )}
              </View>
            ) : null}
            {error ? (
              <Txt size="small" tone="danger" style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>
                {error}
              </Txt>
            ) : null}
            <FlatList
              style={{ flex: 1 }}
              data={rows}
              keyExtractor={rowKey}
              renderItem={renderItem}
              refreshing={pulling}
              onRefresh={refresh}
              initialNumToRender={40}
              maxToRenderPerBatch={40}
              windowSize={9}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ flexGrow: 1, paddingBottom: space.lg }}
              ListEmptyComponent={
                <Empty title="No changes" detail="The working tree matches the last commit." />
              }
            />
            <View style={[styles.bar, { paddingBottom: insets.bottom + space.sm }]}>
              {chatId && mine.length > 0 ? (
                <View style={styles.sendComments}>
                  <Tap style={styles.sendCommentsTap} onPress={sendComments}>
                    <Txt size="small" weight="semibold">
                      Send {mine.length} {mine.length === 1 ? 'comment' : 'comments'} to pi
                    </Txt>
                  </Tap>
                </View>
              ) : null}
              <View style={styles.barRow}>
                <Field
                  style={{ flex: 1, maxHeight: 108 }}
                  value={message}
                  onChangeText={setMessage}
                  placeholder="Commit message"
                  multiline
                  accessibilityLabel="Commit message"
                />
                <Button
                  title="Commit"
                  kind="primary"
                  busy={busy === 'commit'}
                  disabled={busy !== null || entries.length === 0 || !message.trim()}
                  onPress={() => void commit()}
                />
                <Button title="Push" busy={busy === 'push'} disabled={busy !== null} onPress={push} />
              </View>
            </View>
          </>
        )}
      </KeyboardAvoidingView>

      <Sheet visible={menuPath !== null} onClose={() => setMenuPath(null)} title={menuPath ?? undefined}>
        {menuPath !== null && menuEntry?.file.status !== 'deleted' && !menuEntry?.file.isBinary ? (
          <SheetAction
            icon={FileText}
            title="Open file"
            onPress={() => {
              const path = menuPath
              setMenuPath(null)
              navigation.navigate('File', { cwd: result?.root ?? cwd, path })
            }}
          />
        ) : null}
        {menuPath !== null ? (
          <SheetAction
            icon={Undo2}
            title="Discard changes"
            danger
            onPress={() => void discard(menuPath)}
          />
        ) : null}
      </Sheet>

      {chatId ? (
        <ReviewSheet
          chatId={chatId}
          visible={reviewMenu}
          onClose={() => setReviewMenu(false)}
          onPick={(model) => void review(model)}
        />
      ) : null}
      <Sheet visible={target !== null} onClose={() => setTarget(null)} title="Comment on this line">
        {target ? (
          <View style={styles.sheetBody}>
            <Mono size={12} tone="muted" numberOfLines={1} ellipsizeMode="head">
              {target.path}
              {targetLine !== undefined ? `:${targetLine}` : ''}
            </Mono>
            {target.line.text.trim() ? (
              <View style={styles.quoted}>
                <Mono size={12.5} tone="text2" numberOfLines={3}>
                  {target.line.text}
                </Mono>
              </View>
            ) : null}
            <Field
              value={draft}
              onChangeText={setDraft}
              placeholder="What should change here?"
              multiline
              autoFocus
              style={{ minHeight: 96, maxHeight: 180, textAlignVertical: 'top' }}
              accessibilityLabel="Comment"
            />
            <Button title="Add comment" kind="primary" disabled={!draft.trim()} onPress={addComment} />
          </View>
        ) : null}
      </Sheet>
    </Screen>
  )
}
