import { useNavigation } from '@react-navigation/native'
import { Clock, History, Play, Plus, Trash2 } from 'lucide-react-native'
import { memo, useCallback, useEffect, useState } from 'react'
import { FlatList, Switch, View } from 'react-native'

import { describeSchedule, nextRunAt, type Automation } from '../desktop'
import { baseName, relativeTime } from '../lib/format'
import { openSession } from '../lib/open'
import type { Nav } from '../nav'
import { api, errorText, EVENTS } from '../remote/api'
import { onOnline, onRemote } from '../state/connection'
import { useData } from '../state/data'
import { makeStyles, space, TOUCH, useTheme } from '../theme'
import { Button, confirm, Empty, Mono, Pixel, Sheet, SheetAction, Tap, toast, Txt } from '../ui'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** "14:30" today, "Mon 09:00" on another day, "now" when it is due. */
function nextLabel(at: number): string {
  const now = new Date()
  if (at <= now.getTime()) {
    return 'now'
  }
  const date = new Date(at)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return date.toDateString() === now.toDateString()
    ? time
    : `${WEEKDAYS[date.getDay()] ?? ''} ${time}`.trim()
}

function runLine(automation: Automation): string {
  let last = 'never run'
  if (automation.lastRunAt !== undefined) {
    const age = relativeTime(automation.lastRunAt)
    last = age === 'now' || age === '' ? 'last run just now' : `last run ${age} ago`
  }
  return automation.enabled ? `${last} · next ${nextLabel(nextRunAt(automation))}` : last
}

const useStyles = makeStyles(() => ({
  root: { flex: 1 },
  intro: { paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.md, paddingBottom: space.sm },
  row: {
    minHeight: TOUCH + 24,
    paddingLeft: space.lg,
    paddingRight: space.md,
    paddingVertical: space.sm + 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md
  },
  body: { flex: 1, minWidth: 0 },
  toggle: { minWidth: TOUCH, minHeight: TOUCH, alignItems: 'center', justifyContent: 'center' },
  loading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg
  }
}))

const AutomationRow = memo(function AutomationRow({
  automation,
  onOpen,
  onMenu,
  onToggle
}: {
  automation: Automation
  onOpen(automation: Automation): void
  onMenu(automation: Automation): void
  onToggle(automation: Automation): void
}) {
  const styles = useStyles()
  const theme = useTheme()
  const project = automation.cwd ? baseName(automation.cwd) : 'no project'
  return (
    <Tap
      onPress={() => onOpen(automation)}
      onLongPress={() => onMenu(automation)}
      accessibilityLabel={`${automation.name}, ${describeSchedule(automation.schedule)}, ${
        automation.enabled ? 'on' : 'off'
      }`}
      accessibilityHint="Long press for more actions"
      style={styles.row}
    >
      <View style={styles.body}>
        <Txt numberOfLines={1} tone={automation.enabled ? 'text' : 'text2'}>
          {automation.name}
        </Txt>
        <Mono size={12} numberOfLines={1}>
          {describeSchedule(automation.schedule)} · {project}
        </Mono>
        <Mono size={12} tone="muted" numberOfLines={1}>
          {runLine(automation)}
        </Mono>
      </View>
      <View style={styles.toggle}>
        <Switch
          value={automation.enabled}
          onValueChange={() => onToggle(automation)}
          accessibilityLabel={`${automation.name} enabled`}
          trackColor={{ false: theme.borderStrong, true: theme.accent }}
          thumbColor={theme.dark ? '#ececee' : '#ffffff'}
        />
      </View>
    </Tap>
  )
})

/** Prompts pi runs on a schedule on the computer. */
export function AutomationsTab() {
  const styles = useStyles()
  const navigation = useNavigation<Nav>()
  const [automations, setAutomations] = useState<Automation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<Automation | null>(null)

  const load = useCallback(() => {
    api.automations
      .list()
      .then((list) => {
        setAutomations(list)
        setError(null)
      })
      .catch((e: unknown) => setError(errorText(e)))
  }, [])

  useEffect(() => {
    load()
    const offOnline = onOnline(load)
    const offChanged = onRemote(EVENTS.automationsChanged, load)
    return () => {
      offOnline()
      offChanged()
    }
  }, [load])

  const openEditor = useCallback(
    (automation: Automation) => navigation.navigate('AutomationEdit', { id: automation.id }),
    [navigation]
  )

  const toggle = useCallback(
    (automation: Automation) => {
      const enabled = !automation.enabled
      setAutomations(
        (current) => current?.map((a) => (a.id === automation.id ? { ...a, enabled } : a)) ?? null
      )
      api.automations
        .save({
          id: automation.id,
          name: automation.name,
          prompt: automation.prompt,
          cwd: automation.cwd,
          schedule: automation.schedule,
          enabled
        })
        .then(load)
        .catch((e: unknown) => {
          toast(errorText(e))
          setAutomations(
            (current) =>
              current?.map((a) => (a.id === automation.id ? { ...a, enabled: !enabled } : a)) ??
              null
          )
        })
    },
    [load]
  )

  const runNow = useCallback(async (automation: Automation) => {
    try {
      await api.automations.runNow(automation.id)
      toast('Started on the computer')
    } catch (e) {
      toast(errorText(e))
    }
  }, [])

  const openLastRun = useCallback(
    (automation: Automation) => {
      const session = useData
        .getState()
        .sessions.find((s) => s.path === automation.lastSessionPath)
      if (session) {
        void openSession(navigation, session)
      } else {
        toast('The chat of the last run is no longer there')
      }
    },
    [navigation]
  )

  const remove = useCallback(
    async (automation: Automation) => {
      const sure = await confirm({
        title: `Delete "${automation.name}"?`,
        message: 'It stops running. Chats from earlier runs are kept.',
        action: 'Delete',
        danger: true
      })
      if (!sure) {
        return
      }
      try {
        await api.automations.delete(automation.id)
        load()
      } catch (e) {
        toast(errorText(e))
      }
    },
    [load]
  )

  const renderItem = useCallback(
    ({ item }: { item: Automation }) => (
      <AutomationRow automation={item} onOpen={openEditor} onMenu={setMenu} onToggle={toggle} />
    ),
    [openEditor, toggle]
  )

  const header = (
    <View style={styles.intro}>
      <Txt size="small" tone="muted">
        Prompts pi runs on a schedule while Pi Desktop is open on the computer.
      </Txt>
      <Button
        title="New automation"
        icon={Plus}
        onPress={() => navigation.navigate('AutomationEdit', {})}
      />
    </View>
  )

  const empty =
    automations === null ? (
      error ? (
        <Empty
          title="Could not load automations"
          detail={error}
          action={<Button title="Retry" onPress={load} />}
        />
      ) : (
        <View style={styles.loading}>
          <Pixel tone="working" />
          <Mono tone="muted">Loading…</Mono>
        </View>
      )
    ) : (
      <Empty
        icon={Clock}
        title="No automations yet"
        detail="Create one to have pi run a prompt every few hours or at a set time."
      />
    )

  return (
    <View style={styles.root}>
      <FlatList
        data={automations ?? []}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        contentContainerStyle={{ paddingBottom: 24 }}
      />
      <Sheet visible={menu !== null} onClose={() => setMenu(null)} title={menu?.name}>
        {menu ? (
          <>
            <SheetAction
              icon={Play}
              title="Run now"
              onPress={() => {
                setMenu(null)
                void runNow(menu)
              }}
            />
            {menu.lastSessionPath ? (
              <SheetAction
                icon={History}
                title="Open last run"
                onPress={() => {
                  setMenu(null)
                  openLastRun(menu)
                }}
              />
            ) : null}
            <SheetAction
              icon={Trash2}
              title="Delete…"
              danger
              onPress={() => {
                setMenu(null)
                void remove(menu)
              }}
            />
          </>
        ) : null}
      </Sheet>
    </View>
  )
}
