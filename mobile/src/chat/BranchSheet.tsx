import { Check, FolderGit2, GitBranch, Plus } from 'lucide-react-native'
import { useEffect, useMemo, useState } from 'react'
import { SectionList, View } from 'react-native'

import type { RepoBranches } from '../desktop'
import { startChat } from '../lib/open'
import type { Nav } from '../nav'
import { api, errorText, EVENTS } from '../remote/api'
import { onRemote } from '../state/connection'
import { useData } from '../state/data'
import { space, TOUCH, useTheme } from '../theme'
import { Empty, Field, haptic, IconButton, Mono, SectionLabel, Sheet, Tap, toast, Txt } from '../ui'

type Row =
  | { kind: 'branch'; key: string; name: string; current: boolean; worktree?: string; detail: string }
  | { kind: 'remote'; key: string; name: string; detail: string }
  | { kind: 'worktree'; key: string; path: string; label: string; detail: string; current: boolean }
  | { kind: 'create-branch'; key: string; name: string }
  | { kind: 'create-worktree'; key: string; name?: string }

function lastTwo(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
}

/**
 * A project's branches and worktrees, from a chat's menu or the Projects
 * tab: switch this folder to a branch, create one, open a branch in a new
 * worktree chat, or go to an existing worktree.
 */
export function BranchSheet({
  cwd,
  visible,
  busy,
  navigation,
  onClose
}: {
  cwd: string
  visible: boolean
  /** pi is running in this folder: no switching under it. */
  busy: boolean
  navigation: Nav
  onClose(): void
}) {
  const theme = useTheme()
  const [data, setData] = useState<RepoBranches | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [working, setWorking] = useState(false)

  useEffect(() => {
    if (!visible) {
      return
    }
    let live = true
    const load = () =>
      api.git.branches(cwd).then(
        (next) => {
          if (live) {
            setData(next)
            setError(null)
          }
        },
        (e: unknown) => live && setError(errorText(e))
      )
    void load()
    const off = onRemote(EVENTS.gitChanged, () => void load())
    return () => {
      live = false
      off()
    }
  }, [visible, cwd])

  const sections = useMemo(() => {
    if (!data) {
      return []
    }
    const needle = query.trim().toLowerCase()
    const match = (text: string) => !needle || text.toLowerCase().includes(needle)
    const branches: Row[] = data.branches
      .filter((b) => match(b.name))
      .map((b) => ({
        kind: 'branch',
        key: `b:${b.name}`,
        name: b.name,
        current: b.current,
        ...(b.worktree ? { worktree: b.worktree } : {}),
        detail: [
          b.current ? 'checked out here' : b.worktree ? 'in a worktree' : '',
          b.ahead ? `↑${b.ahead}` : '',
          b.behind ? `↓${b.behind}` : '',
          b.subject
        ]
          .filter(Boolean)
          .join(' · ')
      }))
    const remotes: Row[] = data.remotes
      .filter((r) => match(r.name))
      .map((r) => ({ kind: 'remote', key: `r:${r.name}`, name: r.name, detail: r.subject }))
    const worktrees: Row[] = data.worktrees
      .filter((w) => !w.prunable && (match(w.path) || match(w.branch ?? '')))
      .map((w) => ({
        kind: 'worktree',
        key: `w:${w.path}`,
        path: w.path,
        label: lastTwo(w.path),
        current: w.current,
        detail: [w.current ? 'this chat' : '', w.main ? 'main checkout' : '', w.branch ?? 'detached']
          .filter(Boolean)
          .join(' · ')
      }))
    const typed = query.trim()
    const exists =
      data.branches.some((b) => b.name === typed) || data.remotes.some((r) => r.branch === typed)
    const create: Row[] =
      typed && !exists
        ? [
            { kind: 'create-branch', key: 'c:branch', name: typed },
            { kind: 'create-worktree', key: 'c:worktree', name: typed }
          ]
        : typed
          ? []
          : [{ kind: 'create-worktree', key: 'c:worktree' }]
    return [
      { title: '', data: create },
      { title: 'Branches', data: branches },
      { title: 'Remote branches', data: remotes },
      { title: 'Worktrees', data: worktrees }
    ].filter((s) => s.data.length > 0)
  }, [data, query])

  const close = (): void => {
    setQuery('')
    onClose()
  }

  const openWorktree = async (path: string): Promise<void> => {
    try {
      await api.projects.add(path)
      await useData.getState().refresh()
      close()
      startChat(navigation, path)
    } catch (e) {
      toast(errorText(e))
    }
  }

  const newWorktree = async (source?: Parameters<typeof api.projects.createWorktree>[1]): Promise<void> => {
    setWorking(true)
    try {
      toast('Creating a worktree…')
      const worktree = await api.projects.createWorktree(cwd, source)
      await useData.getState().refresh()
      haptic('success')
      close()
      startChat(navigation, worktree.cwd)
      toast(`New worktree on ${worktree.branch}`)
    } catch (e) {
      toast(`Could not create a worktree: ${errorText(e)}`)
    } finally {
      setWorking(false)
    }
  }

  const press = async (row: Row): Promise<void> => {
    if (working) {
      return
    }
    if (row.kind === 'worktree') {
      if (row.current) {
        close()
      } else {
        await openWorktree(row.path)
      }
      return
    }
    if (row.kind === 'branch' && row.current) {
      close()
      return
    }
    if (row.kind === 'branch' && row.worktree) {
      // Git checks a branch out in one place only: go to where it is.
      await openWorktree(row.worktree)
      return
    }
    if (row.kind === 'create-worktree') {
      await newWorktree(row.name ? { kind: 'new', branch: row.name } : undefined)
      return
    }
    if (busy) {
      toast('pi is working in this folder: wait for it to finish, or use a worktree')
      return
    }
    setWorking(true)
    try {
      const result =
        row.kind === 'create-branch'
          ? await api.git.createBranch(cwd, row.name)
          : await api.git.switchBranch(cwd, row.name)
      toast(result.ok ? result.message : `Git refused: ${result.message}`)
      if (result.ok) {
        haptic('success')
        close()
      }
    } catch (e) {
      toast(errorText(e))
    } finally {
      setWorking(false)
    }
  }

  const title = (row: Row): string =>
    row.kind === 'create-branch'
      ? `Create “${row.name}” and switch to it`
      : row.kind === 'create-worktree'
        ? row.name
          ? `New worktree chat on “${row.name}”`
          : 'New worktree chat (new pi/ branch)'
        : row.kind === 'worktree'
          ? row.label
          : row.name

  return (
    <Sheet visible={visible} onClose={close} title="Branches" scroll={false}>
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.sm }}>
        <Field
          value={query}
          onChangeText={setQuery}
          placeholder="Find a branch or name a new one"
          accessibilityLabel="Branch name"
          autoCorrect={false}
          autoCapitalize="none"
        />
        {data && data.changes > 0 ? (
          <Txt size="small" tone="muted">
            {data.changes} changed {data.changes === 1 ? 'file comes' : 'files come'} along on a switch; git
            refuses if they would be overwritten.
          </Txt>
        ) : null}
        {busy ? (
          <Txt size="small" tone="muted">
            pi is working in this folder: switching waits until it is done.
          </Txt>
        ) : null}
      </View>
      <SectionList
        style={{ maxHeight: 440 }}
        sections={sections}
        keyExtractor={(row) => row.key}
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) =>
          section.title ? (
            <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, backgroundColor: theme.raised }}>
              <SectionLabel>{section.title}</SectionLabel>
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const Icon =
            item.kind === 'create-branch' || item.kind === 'create-worktree'
              ? Plus
              : item.kind === 'worktree'
                ? FolderGit2
                : item.kind === 'branch' && item.current
                  ? Check
                  : GitBranch
          const detail = 'detail' in item ? item.detail : ''
          const canBranchOff =
            (item.kind === 'branch' && !item.current && !item.worktree) || item.kind === 'remote'
          return (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Tap
                onPress={() => void press(item)}
                disabled={working}
                accessibilityLabel={title(item)}
                style={{
                  flex: 1,
                  minHeight: TOUCH,
                  paddingHorizontal: space.lg,
                  paddingVertical: space.sm,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.md
                }}
              >
                <Icon size={17} color={item.kind === 'branch' && item.current ? theme.accent : theme.text2} strokeWidth={1.75} />
                <View style={{ flex: 1 }}>
                  <Txt weight={item.kind === 'branch' && item.current ? 'semibold' : 'regular'} numberOfLines={1}>
                    {title(item)}
                  </Txt>
                  {detail ? (
                    <Mono size={12} tone="muted" numberOfLines={1}>
                      {detail}
                    </Mono>
                  ) : null}
                </View>
              </Tap>
              {canBranchOff ? (
                <IconButton
                  icon={FolderGit2}
                  label={`Open ${'name' in item ? item.name : ''} in a new worktree chat`}
                  onPress={() => void newWorktree({ kind: 'existing', branch: 'name' in item ? item.name : '' })}
                />
              ) : null}
            </View>
          )
        }}
        ListEmptyComponent={
          error ? (
            <Empty title="Could not read the branches" detail={error} />
          ) : !data ? (
            <Empty title="Reading branches…" />
          ) : (
            <Empty title="No branch matches" />
          )
        }
      />
    </Sheet>
  )
}
