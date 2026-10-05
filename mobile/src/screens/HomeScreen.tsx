import { ChevronsUpDown, Clock, FolderGit2, MessagesSquare, Monitor, Plus, Server, Settings, type LucideIcon } from 'lucide-react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import { useCallback, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useConnection } from '../state/connection'
import { setListsVisible } from '../state/data'
import { radius, space, useTheme } from '../theme'
import type { Nav } from '../nav'
import { Button, Mono, Pixel, Sheet, SheetAction, Tap, Txt } from '../ui'
import { AutomationsTab } from './AutomationsTab'
import { ChatsTab } from './ChatsTab'
import { ProjectsTab } from './ProjectsTab'
import { SettingsTab } from './SettingsTab'

type TabId = 'chats' | 'projects' | 'automations' | 'settings'

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'chats', label: 'Chats', icon: MessagesSquare },
  { id: 'projects', label: 'Projects', icon: FolderGit2 },
  { id: 'automations', label: 'Automations', icon: Clock },
  { id: 'settings', label: 'Settings', icon: Settings }
]

/**
 * The app's home: the computer's name and link state on top, four tabs at
 * the bottom. A tab is mounted the first time it is shown and then kept, so
 * switching back is instant and keeps its scroll position.
 */
export function HomeScreen() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const phase = useConnection((s) => s.phase)
  const name = useConnection((s) => s.server?.name ?? s.pairing?.name ?? 'Computer')
  const computers = useConnection((s) => s.computers)
  const activeKey = useConnection((s) => s.pairing?.key ?? null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const navigation = useNavigation<Nav>()
  const [tab, setTab] = useState<TabId>('chats')
  const [mounted, setMounted] = useState<Set<TabId>>(() => new Set<TabId>(['chats']))

  // The lists only follow the computer while this screen is on top.
  useFocusEffect(
    useCallback(() => {
      setListsVisible(true)
      return () => setListsVisible(false)
    }, [])
  )

  const select = (id: TabId): void => {
    if (!mounted.has(id)) {
      setMounted(new Set(mounted).add(id))
    }
    setTab(id)
  }

  const pane = (id: TabId, node: React.ReactNode): React.ReactNode =>
    mounted.has(id) ? (
      <View key={id} style={[StyleSheet.absoluteFill, tab === id ? null : { display: 'none' }]}>
        {node}
      </View>
    ) : null

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top }}>
      <View
        style={{
          minHeight: 56,
          paddingHorizontal: space.lg,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.border
        }}
      >
        <Pixel tone={phase === 'online' ? 'ok' : phase === 'connecting' || phase === 'loading' ? 'working' : 'error'} size={9} />
        <Tap
          style={{ flex: 1, minHeight: 48, justifyContent: 'center' }}
          label={`${name}, ${phase === 'online' ? 'connected' : phase}. ${computers.length > 1 ? 'Switch computer' : 'Computers'}`}
          onPress={() => setSwitcherOpen(true)}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
            <Txt size="heading" weight="semibold" numberOfLines={1} accessibilityRole="header" style={{ flexShrink: 1 }}>
              {name}
            </Txt>
            {computers.length > 1 ? <ChevronsUpDown size={16} color={theme.muted} strokeWidth={1.75} /> : null}
          </View>
          <Mono size={12} tone="muted">
            {phase === 'online' ? 'connected' : phase === 'offline' ? 'offline' : 'connecting…'}
          </Mono>
        </Tap>
      </View>
      <Sheet visible={switcherOpen} onClose={() => setSwitcherOpen(false)} title="Computers">
        {computers.map((computer) => (
          <SheetAction
            key={computer.key}
            icon={computer.kind === 'server' ? Server : Monitor}
            title={computer.name}
            detail={`${computer.kind === 'server' ? 'pi-remote' : 'Pi Desktop'} · ${computer.lastHost ?? computer.hosts[0] ?? ''}`}
            selected={computer.key === activeKey}
            onPress={() => {
              setSwitcherOpen(false)
              if (computer.key !== activeKey) {
                void useConnection.getState().switchTo(computer.key)
              }
            }}
          />
        ))}
        <SheetAction
          icon={Plus}
          title="Pair another computer"
          onPress={() => {
            setSwitcherOpen(false)
            navigation.navigate('AddComputer', {})
          }}
        />
      </Sheet>
      {phase === 'offline' ? (
        <View
          accessibilityRole="alert"
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: theme.dangerSoft }}
        >
          <Txt size="small" tone="text2" style={{ flex: 1 }}>
            Cannot reach the computer. Trying again…
          </Txt>
          <Button title="Retry" onPress={() => useConnection.getState().retry()} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        {pane('chats', <ChatsTab />)}
        {pane('projects', <ProjectsTab />)}
        {pane('automations', <AutomationsTab />)}
        {pane('settings', <SettingsTab />)}
      </View>
      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: 'row',
          paddingBottom: insets.bottom,
          paddingHorizontal: space.xs,
          backgroundColor: theme.chrome,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.border
        }}
      >
        {TABS.map(({ id, label, icon: Icon }) => {
          const selected = tab === id
          return (
            <View key={id} style={{ flex: 1, borderRadius: radius.md, overflow: 'hidden', marginVertical: space.xs }}>
              <Tap
                testID={`tab-${id}`}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => select(id)}
                style={{ minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 3 }}
              >
                <Icon size={21} color={selected ? theme.text : theme.muted} strokeWidth={selected ? 2 : 1.6} />
                <Txt size="caption" weight={selected ? 'semibold' : 'regular'} tone={selected ? 'text' : 'muted'} style={{ fontSize: 12, lineHeight: 15 }}>
                  {label}
                </Txt>
              </Tap>
            </View>
          )
        })}
      </View>
    </View>
  )
}
