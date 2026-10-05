import { useNavigation } from '@react-navigation/native'
import { ChevronRight, Monitor, Plus, Server } from 'lucide-react-native'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ScrollView, StyleSheet, Switch, View } from 'react-native'

import type { CuaPermissions, PiRuntimeInfo } from '../desktop'
import type { Nav } from '../nav'
import type { StoredPairing } from '../remote/storage'
import { api } from '../remote/api'
import { onOnline, useConnection } from '../state/connection'
import { MAX_COMPUTERS } from '../remote/storage'
import { usePrefs, type ThemePref } from '../state/prefs'
import { makeStyles, radius, space, TOUCH, useTheme } from '../theme'
import {
  Button,
  confirm,
  Divider,
  haptic,
  Mono,
  Pixel,
  Row,
  SectionLabel,
  Segmented,
  toast,
  Txt,
  type PixelTone
} from '../ui'
import { TextSheet } from '../chat/sheets'
import { errorText } from '../remote/api'
import { disableNotifications, enableNotifications, notificationsSupported } from '../lib/background'

const APP_VERSION = '0.2.0'

const useStyles = makeStyles((t) => ({
  root: { flex: 1 },
  content: { padding: space.lg, paddingBottom: 24, gap: space.xl },
  card: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.border,
    backgroundColor: t.surface,
    overflow: 'hidden'
  },
  block: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  readout: {
    minHeight: TOUCH,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md
  },
  readoutValue: { flex: 1, textAlign: 'right' },
  toggleRow: {
    minHeight: TOUCH + 8,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md
  },
  flex: { flex: 1 }
}))

function Card({ label, children }: { label: string; children: ReactNode }) {
  const styles = useStyles()
  return (
    <View>
      <SectionLabel>{label}</SectionLabel>
      <View style={styles.card}>{children}</View>
    </View>
  )
}

function Readout({ label, value }: { label: string; value: string }) {
  const styles = useStyles()
  return (
    <View style={styles.readout} accessible accessibilityLabel={`${label}: ${value}`}>
      <Txt size="small" tone="text2">
        {label}
      </Txt>
      <Mono style={styles.readoutValue} numberOfLines={1} ellipsizeMode="middle">
        {value}
      </Mono>
    </View>
  )
}

/**
 * Every paired computer: tap one to use it, long-press to forget it, and
 * pair another from here.
 */
function ComputersCard({
  computers,
  active,
  status
}: {
  computers: StoredPairing[]
  active: string | null
  status: { tone: PixelTone; text: string }
}) {
  const styles = useStyles()
  const theme = useTheme()
  const navigation = useNavigation<Nav>()

  const forget = async (computer: StoredPairing): Promise<void> => {
    const sure = await confirm({
      title: `Forget ${computer.name}?`,
      message:
        'This phone stops connecting to it. To use it again, pair with a new QR code. Also remove this phone on that computer (Settings → Remote control, or "pi-remote revoke" on a server).',
      action: 'Forget',
      danger: true
    })
    if (sure) {
      await useConnection.getState().unpair(computer.key)
      toast(`${computer.name} forgotten`)
    }
  }

  return (
    <Card label="Computers">
      {computers.map((computer, index) => {
        const inUse = computer.key === active
        const Icon = computer.kind === 'server' ? Server : Monitor
        const address = computer.lastHost ?? computer.hosts[0] ?? ''
        return (
          <View key={computer.key}>
            {index > 0 ? <Divider /> : null}
            <Row
              title={computer.name}
              detail={`${computer.kind === 'server' ? 'pi-remote' : 'Pi Desktop'} · ${address}:${computer.port}`}
              left={<Icon size={18} color={inUse ? theme.accent : theme.muted} strokeWidth={1.75} />}
              right={
                inUse ? (
                  <View style={styles.status}>
                    <Pixel tone={status.tone} />
                    <Txt size="caption" tone="text2">
                      {status.text}
                    </Txt>
                  </View>
                ) : null
              }
              onPress={
                inUse
                  ? undefined
                  : () => {
                      haptic('tap')
                      void useConnection
                        .getState()
                        .switchTo(computer.key)
                        .then(() => toast(`Using ${computer.name}`))
                    }
              }
              onLongPress={() => void forget(computer)}
              testID={`computer-${index}`}
            />
          </View>
        )
      })}
      <Divider />
      <View style={styles.block}>
        {computers.length > 1 ? (
          <Txt size="caption" tone="muted">
            Tap a computer to use it. Long-press to forget it.
          </Txt>
        ) : null}
        <Button
          title="Pair another computer"
          icon={Plus}
          disabled={computers.length >= MAX_COMPUTERS}
          onPress={() => navigation.navigate('AddComputer', {})}
        />
      </View>
    </Card>
  )
}

/** The paired computers, this phone's preferences, and what runs where. */
export function SettingsTab() {
  const styles = useStyles()
  const theme = useTheme()
  const navigation = useNavigation<Nav>()
  const phase = useConnection((s) => s.phase)
  const pairing = useConnection((s) => s.pairing)
  const computers = useConnection((s) => s.computers)
  const server = useConnection((s) => s.server)
  const error = useConnection((s) => s.error)
  const themePref = usePrefs((s) => s.theme)
  const haptics = usePrefs((s) => s.haptics)
  const notifications = usePrefs((s) => s.notifications)
  const [runtime, setRuntime] = useState<PiRuntimeInfo | null>(null)
  const [cua, setCua] = useState<CuaPermissions | null>(null)
  const [addressOpen, setAddressOpen] = useState(false)

  const load = useCallback(() => {
    api.app
      .runtime()
      .then(setRuntime)
      .catch(() => {})
    api.cua
      .permissions()
      .then(setCua)
      .catch(() => {})
  }, [])

  useEffect(() => {
    load()
    const off = onOnline(load)
    return () => {
      off()
    }
  }, [load])

  const unpair = useCallback(async () => {
    const name = useConnection.getState().pairing?.name ?? 'this computer'
    const sure = await confirm({
      title: `Forget ${name}?`,
      message:
        'This phone stops connecting to it; to use it again it must be paired with a new QR code. Also remove this phone on that computer (Settings → Remote control, or "pi-remote revoke" on a server).',
      action: 'Forget',
      danger: true
    })
    if (sure) {
      await useConnection.getState().unpair()
    }
  }, [])

  const status: { tone: PixelTone; text: string } =
    phase === 'online'
      ? { tone: 'ok', text: 'Connected' }
      : phase === 'offline'
        ? { tone: 'error', text: 'Offline' }
        : { tone: 'working', text: 'Connecting…' }

  const host = pairing ? (pairing.lastHost ?? pairing.hosts[0]) : undefined
  const switchColors = {
    trackColor: { false: theme.borderStrong, true: theme.accent },
    thumbColor: theme.dark ? '#ececee' : '#ffffff'
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <ComputersCard computers={computers} active={pairing?.key ?? null} status={status} />
      <Card label="In use">
        <View style={styles.block}>
          <Txt weight="semibold" numberOfLines={1}>
            {server?.name ?? pairing?.name ?? 'Computer'}
          </Txt>
          <View style={styles.status}>
            <Pixel tone={status.tone} />
            <Txt size="small" tone="text2">
              {status.text}
            </Txt>
          </View>
          {phase === 'offline' ? (
            <>
              {error ? (
                <Txt size="small" tone="danger">
                  {error}
                </Txt>
              ) : null}
              <Button title="Retry" onPress={() => useConnection.getState().retry()} />
            </>
          ) : null}
        </View>
        <Divider />
        <Readout label="Address" value={host && pairing ? `${host}:${pairing.port}` : '—'} />
        <Divider />
        <Readout label={server?.kind === 'server' ? 'pi-remote' : 'Pi Desktop'} value={server?.version ?? '—'} />
        <Divider />
        <Readout
          label="pi runtime"
          value={runtime ? `${runtime.kind} ${runtime.version ?? 'unknown version'}` : '—'}
        />
        <Divider />
        <View style={styles.block}>
          <Txt size="small" tone="muted">
            End-to-end encrypted between this phone and the computer.
          </Txt>
          <Button title="Use another address" onPress={() => setAddressOpen(true)} />
          <Button title="Forget this computer" kind="danger" onPress={() => void unpair()} />
        </View>
      </Card>
      <TextSheet
        visible={addressOpen}
        title="Computer address"
        label="The computer's IP address or name on this network (for example its Tailscale address). It is tried first from now on."
        action="Use this address"
        onClose={() => setAddressOpen(false)}
        onSubmit={(value) => {
          void useConnection
            .getState()
            .addHost(value)
            .then(() => toast('Address added'))
            .catch((e) => toast(errorText(e)))
        }}
      />

      <Card label="Appearance">
        <View style={styles.block}>
          <Txt size="small" tone="text2">
            Theme
          </Txt>
          <Segmented<ThemePref>
            value={themePref}
            onChange={(theme) => usePrefs.getState().set({ theme })}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' }
            ]}
          />
        </View>
        <Divider />
        <View style={styles.toggleRow}>
          <Txt style={styles.flex}>Haptics</Txt>
          <Switch
            value={haptics}
            onValueChange={(value) => usePrefs.getState().set({ haptics: value })}
            accessibilityLabel="Haptics"
            {...switchColors}
          />
        </View>
      </Card>

      {notificationsSupported() ? (
        <Card label="Notifications">
          <View style={styles.toggleRow}>
            <View style={styles.flex}>
              <Txt>When pi finishes or needs you</Txt>
              <Txt size="caption" tone="muted">
                While pi works, the app stays connected in the background (an ongoing notification
                shows it) and tells you when a chat is done.
              </Txt>
            </View>
            <Switch
              value={notifications === true}
              onValueChange={(value) => {
                if (!value) {
                  disableNotifications()
                  return
                }
                void enableNotifications().then((granted) => {
                  if (!granted) {
                    toast('Notifications are off for Pi Remote in the system settings')
                  }
                })
              }}
              accessibilityLabel="Notify when pi finishes or needs you"
              {...switchColors}
            />
          </View>
        </Card>
      ) : null}

      <Card label="Usage">
        <Row
          title="Usage"
          detail="Tokens and cost over the last 30 days"
          onPress={() => navigation.navigate('Usage')}
          right={<ChevronRight size={18} color={theme.muted} strokeWidth={1.75} />}
        />
      </Card>

      <Card label="Computer use">
        {cua === null ? (
          <View style={styles.block}>
            <Mono tone="muted">{phase === 'online' ? 'Loading…' : 'Not connected'}</Mono>
          </View>
        ) : !cua.available ? (
          <View style={styles.block}>
            <Txt size="small" tone="text2">
              Not available on this computer
            </Txt>
          </View>
        ) : (
          <>
            <Readout label="Accessibility" value={cua.accessibility ? 'granted' : 'not granted'} />
            <Divider />
            <Readout
              label="Screen Recording"
              value={cua.screenRecording ? 'granted' : 'not granted'}
            />
            <Divider />
            <View style={styles.block}>
              <Txt size="small" tone="muted">
                Permissions are changed on the computer, in Pi Desktop's settings.
              </Txt>
            </View>
          </>
        )}
      </Card>

      <Card label="About">
        <Readout label="Pi Remote" value={APP_VERSION} />
      </Card>
    </ScrollView>
  )
}
