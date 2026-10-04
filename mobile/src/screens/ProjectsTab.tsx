import { useNavigation } from '@react-navigation/native'
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Plus,
  Trash2
} from 'lucide-react-native'
import { memo, useCallback, useMemo, useState } from 'react'
import { FlatList, RefreshControl, View } from 'react-native'

import type { ProjectSummary, SessionSummary } from '../desktop'
import { pickFolder } from '../lib/folder-pick'
import { baseName, relativeTime } from '../lib/format'
import { openSession, startChat } from '../lib/open'
import type { Nav } from '../nav'
import { api, errorText } from '../remote/api'
import { liveStateFor, useData } from '../state/data'
import { makeStyles, space, TOUCH, useTheme } from '../theme'
import {
  confirm,
  Empty,
  Mono,
  ScratchSigil,
  SectionLabel,
  Sheet,
  SheetAction,
  Sigil,
  Tap,
  toast,
  Txt,
  type PixelTone
} from '../ui'
import { SessionRow } from '../ui/SessionRow'

const MAX_SESSIONS = 30

type Item =
  | { kind: 'add'; key: string }
  | { kind: 'scratch'; key: string }
  | { kind: 'label'; key: string }
  | { kind: 'empty'; key: string }
  | { kind: 'project'; key: string; project: ProjectSummary; expanded: boolean }
  | { kind: 'new'; key: string; cwd: string }
  | { kind: 'none'; key: string }
  | { kind: 'session'; key: string; session: SessionSummary; status: PixelTone | null }

const useStyles = makeStyles(() => ({
  root: { flex: 1 },
  row: {
    minHeight: TOUCH + 12,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md
  },
  body: { flex: 1, minWidth: 0 },
  nested: { paddingLeft: space.xl },
  nestedRow: {
    minHeight: TOUCH,
    paddingLeft: space.lg + space.xl,
    paddingRight: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md
  },
  label: { paddingHorizontal: space.lg, paddingTop: space.lg }
}))

function projectDetail(project: ProjectSummary): string {
  const count = `${project.sessionCount} ${project.sessionCount === 1 ? 'chat' : 'chats'}`
  return [count, project.worktree ? 'worktree' : '', relativeTime(project.lastModified)]
    .filter(Boolean)
    .join(' · ')
}

const ProjectRow = memo(function ProjectRow({
  project,
  expanded,
  onToggle,
  onMenu
}: {
  project: ProjectSummary
  expanded: boolean
  onToggle(cwd: string): void
  onMenu(project: ProjectSummary): void
}) {
  const styles = useStyles()
  const theme = useTheme()
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <Tap
      onPress={() => onToggle(project.cwd)}
      onLongPress={() => onMenu(project)}
      accessibilityLabel={`${project.name}, ${projectDetail(project)}`}
      accessibilityHint="Long press for more actions"
      accessibilityState={{ expanded }}
      style={styles.row}
    >
      <Sigil seed={project.cwd} size={18} />
      <View style={styles.body}>
        <Txt numberOfLines={1}>{project.name}</Txt>
        <Mono size={12} tone="muted" numberOfLines={1}>
          {projectDetail(project)}
        </Mono>
      </View>
      <Chevron size={18} color={theme.muted} strokeWidth={1.75} />
    </Tap>
  )
})

const NewChatRow = memo(function NewChatRow({
  cwd,
  onPress
}: {
  cwd: string
  onPress(cwd: string): void
}) {
  const styles = useStyles()
  const theme = useTheme()
  return (
    <Tap onPress={() => onPress(cwd)} style={styles.nestedRow}>
      <Plus size={18} color={theme.text2} strokeWidth={1.75} />
      <Txt tone="text2">New chat</Txt>
    </Tap>
  )
})

/** Projects on the computer, each opening to its chats. */
export function ProjectsTab() {
  const styles = useStyles()
  const theme = useTheme()
  const navigation = useNavigation<Nav>()
  const projects = useData((s) => s.projects)
  const sessions = useData((s) => s.sessions)
  const meta = useData((s) => s.meta)
  const live = useData((s) => s.live)
  const appInfo = useData((s) => s.appInfo)
  const loaded = useData((s) => s.loaded)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<ProjectSummary | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [
      { kind: 'add', key: 'add' },
      { kind: 'scratch', key: 'scratch' },
      { kind: 'label', key: 'label' }
    ]
    if (projects.length === 0) {
      list.push({ kind: 'empty', key: 'empty' })
    }
    for (const project of projects) {
      const open = !!expanded[project.cwd]
      list.push({ kind: 'project', key: `p:${project.cwd}`, project, expanded: open })
      if (!open) {
        continue
      }
      list.push({ kind: 'new', key: `n:${project.cwd}`, cwd: project.cwd })
      const own = sessions
        .filter((s) => s.cwd === project.cwd && !meta[s.path]?.archived)
        .sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0))
        .slice(0, MAX_SESSIONS)
      if (own.length === 0) {
        list.push({ kind: 'none', key: `e:${project.cwd}` })
      }
      for (const session of own) {
        list.push({
          kind: 'session',
          key: `s:${session.path}`,
          session,
          status: liveStateFor(live, session.path)
        })
      }
    }
    return list
  }, [projects, sessions, meta, live, expanded])

  const refresh = useCallback(async () => {
    try {
      await useData.getState().refresh()
    } catch (e) {
      toast(errorText(e))
    }
  }, [])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await refresh()
    setRefreshing(false)
  }, [refresh])

  const toggle = useCallback((cwd: string) => {
    setExpanded((current) => ({ ...current, [cwd]: !current[cwd] }))
  }, [])

  const newChat = useCallback((cwd: string) => startChat(navigation, cwd), [navigation])

  const open = useCallback(
    (session: SessionSummary) => void openSession(navigation, session),
    [navigation]
  )

  const addProject = useCallback(async () => {
    const path = await pickFolder(navigation, 'Add a project')
    if (!path) {
      return
    }
    try {
      await api.projects.add(path)
      await useData.getState().refresh()
      toast(`Added ${baseName(path)}`)
    } catch (e) {
      toast(errorText(e))
    }
  }, [navigation])

  const startScratch = useCallback(() => {
    if (appInfo) {
      startChat(navigation, appInfo.workspaceDir)
    } else {
      toast('Not connected to the computer')
    }
  }, [appInfo, navigation])

  const createWorktree = useCallback(
    async (cwd: string) => {
      try {
        toast('Creating a worktree…')
        const worktree = await api.projects.createWorktree(cwd)
        await useData.getState().refresh()
        startChat(navigation, worktree.cwd)
      } catch (e) {
        toast(errorText(e))
      }
    },
    [navigation]
  )

  const removeWorktree = useCallback(
    async (project: ProjectSummary) => {
      const sure = await confirm({
        title: `Remove the worktree "${project.name}"?`,
        message: 'Its folder is deleted on the computer. The branch is kept.',
        action: 'Remove',
        danger: true
      })
      if (!sure) {
        return
      }
      try {
        let result = await api.projects.removeWorktree(project.cwd)
        if (!result.ok) {
          const force = await confirm({
            title: 'Remove anyway?',
            message: `${result.message}\n\nRemove anyway? Uncommitted changes in it are lost.`,
            action: 'Remove anyway',
            danger: true
          })
          if (!force) {
            return
          }
          result = await api.projects.removeWorktree(project.cwd, true)
        }
        toast(result.message)
      } catch (e) {
        toast(errorText(e))
      }
      await refresh()
    },
    [refresh]
  )

  const renderItem = useCallback(
    ({ item }: { item: Item }) => {
      switch (item.kind) {
        case 'add':
          return (
            <Tap onPress={() => void addProject()} style={styles.row}>
              <FolderPlus size={18} color={theme.text2} strokeWidth={1.75} />
              <View style={styles.body}>
                <Txt>Add a project</Txt>
                <Mono size={12} tone="muted" numberOfLines={1}>
                  a folder on the computer
                </Mono>
              </View>
            </Tap>
          )
        case 'scratch':
          return (
            <Tap onPress={startScratch} disabled={!appInfo} style={styles.row}>
              <ScratchSigil size={18} />
              <View style={styles.body}>
                <Txt>Without a project</Txt>
                <Mono size={12} tone="muted" numberOfLines={1}>
                  new chat in the scratch folder
                </Mono>
              </View>
              <Plus size={18} color={theme.muted} strokeWidth={1.75} />
            </Tap>
          )
        case 'label':
          return <SectionLabel style={styles.label}>Projects</SectionLabel>
        case 'empty':
          return (
            <Empty
              icon={FolderOpen}
              title={loaded ? 'No projects yet' : 'Loading…'}
              detail={
                loaded
                  ? 'Add a folder on the computer to start chats in it.'
                  : 'Waiting for the computer.'
              }
            />
          )
        case 'project':
          return (
            <ProjectRow
              project={item.project}
              expanded={item.expanded}
              onToggle={toggle}
              onMenu={setMenu}
            />
          )
        case 'new':
          return <NewChatRow cwd={item.cwd} onPress={newChat} />
        case 'none':
          return (
            <View style={styles.nestedRow}>
              <Mono size={12} tone="muted">
                no chats yet
              </Mono>
            </View>
          )
        case 'session':
          return (
            <View style={styles.nested}>
              <SessionRow
                session={item.session}
                status={item.status}
                pinned={!!meta[item.session.path]?.pinned}
                showProject={false}
                onPress={open}
              />
            </View>
          )
      }
    },
    [addProject, appInfo, loaded, meta, newChat, open, startScratch, styles, theme, toggle]
  )

  return (
    <View style={styles.root}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        contentContainerStyle={{ paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            colors={[theme.accent]}
            tintColor={theme.accent}
            progressBackgroundColor={theme.raised}
          />
        }
      />
      <Sheet visible={menu !== null} onClose={() => setMenu(null)} title={menu?.name}>
        {menu ? (
          <>
            <SheetAction
              icon={Plus}
              title="New chat"
              onPress={() => {
                setMenu(null)
                newChat(menu.cwd)
              }}
            />
            {menu.worktree ? (
              <SheetAction
                icon={Trash2}
                title="Remove worktree…"
                danger
                onPress={() => {
                  setMenu(null)
                  void removeWorktree(menu)
                }}
              />
            ) : (
              <SheetAction
                icon={GitBranch}
                title="New chat in a worktree"
                detail="An isolated copy of the project on its own branch"
                onPress={() => {
                  setMenu(null)
                  void createWorktree(menu.cwd)
                }}
              />
            )}
          </>
        ) : null}
      </Sheet>
    </View>
  )
}
