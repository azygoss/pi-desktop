import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Clipboard from 'expo-clipboard'
import { ClipboardPaste, ScanLine, X } from 'lucide-react-native'
import { useEffect, useRef, useState } from 'react'
import { BackHandler, Linking, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { parsePairingPayload } from '../desktop'
import type { Nav, RootStackParamList } from '../nav'
import { takeLaunchLink } from '../lib/background'
import { errorText } from '../remote/api'
import { useConnection } from '../state/connection'
import { radius, space, useTheme } from '../theme'
import { Button, Field, haptic, IconButton, Mono, Pixel, Screen, toast, Txt } from '../ui'

let initialUrlSeen = false

const STEPS = [
  'Open Pi Desktop on your computer',
  'Go to Settings → Remote control',
  'Choose "Show pairing code" and scan it here'
]

// The pi mark's own colors, on its 4×4 grid (see ../../../build/pi-logo.svg).
const MARK: (string | null)[] = [
  '#F09082', '#F09082', '#F09082', null,
  '#4D9ABF', null, '#F09082', null,
  '#4D9ABF', '#4D9ABF', null, '#F1BE58',
  '#4D9ABF', null, null, '#F1BE58'
]

function Mark() {
  const cell = 14
  return (
    <View style={{ width: cell * 4, flexDirection: 'row', flexWrap: 'wrap' }} accessibilityLabel="Pi Remote">
      {MARK.map((color, i) => (
        <View key={i} style={{ width: cell, height: cell, backgroundColor: color ?? 'transparent' }} />
      ))}
    </View>
  )
}

/**
 * Pair this phone with a computer by scanning the one-time QR code Pi
 * Desktop (or `pi-remote pair`) shows, or by pasting its link. The first
 * run shows it on its own; later it opens over the app to add a computer.
 */
export function PairScreen() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const navigation = useNavigation<Nav>()
  const route = useRoute<RouteProp<RootStackParamList, 'AddComputer' | 'Pair'>>()
  // Mounted as AddComputer: another computer is already paired.
  const adding = route.name === 'AddComputer'
  const routeLink = adding ? (route.params as { link?: string } | undefined)?.link : undefined
  const storeError = useConnection((s) => s.error)
  const [permission, requestPermission] = useCameraPermissions()
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState('')
  const handled = useRef(false)

  const pair = async (text: string): Promise<void> => {
    const payload = parsePairingPayload(text)
    if (!payload) {
      setError('That is not a Pi Desktop pairing code.')
      return
    }
    setScanning(false)
    setError(null)
    setBusy(payload.name)
    try {
      await useConnection.getState().pair(text)
      haptic('success')
      if (adding) {
        toast(`Paired with ${useConnection.getState().pairing?.name ?? payload.name}`)
        // Closed while it connected: nothing to leave.
        if (navigation.isFocused()) {
          navigation.goBack()
        }
      }
    } catch (e) {
      haptic('warning')
      setError(useConnection.getState().error ?? errorText(e))
    } finally {
      setBusy(null)
      handled.current = false
    }
  }

  // The system camera (or a tapped link) can open the app with the pairing
  // link itself: pair straight away.
  const pairRef = useRef(pair)
  pairRef.current = pair
  useEffect(() => {
    const open = (url: string | null): void => {
      if (url && parsePairingPayload(url) && !handled.current) {
        handled.current = true
        void pairRef.current(url)
      }
    }
    if (adding) {
      // Links that arrive while paired are routed here by the app.
      open(routeLink ?? null)
      return
    }
    // The launch link is only news once: after an unpair it is long spent.
    const kept = takeLaunchLink('pidesktop://pair')
    if (kept) {
      initialUrlSeen = true
      open(kept)
    } else if (!initialUrlSeen) {
      initialUrlSeen = true
      void Linking.getInitialURL().then(open).catch(() => {})
    }
    const subscription = Linking.addEventListener('url', (event) => open(event.url))
    return () => subscription.remove()
  }, [adding, routeLink])

  // Back leaves the scanner, not the app.
  useEffect(() => {
    if (!scanning) {
      return
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setScanning(false)
      return true
    })
    return () => subscription.remove()
  }, [scanning])

  const startScan = async (): Promise<void> => {
    setError(null)
    const current = permission?.granted ? permission : await requestPermission()
    if (!current.granted) {
      setError(
        current.canAskAgain
          ? 'Camera access is needed to scan the code. You can also paste the pairing link below.'
          : 'Camera access is off for Pi Remote. Turn it on in the system settings, or paste the pairing link below.'
      )
      if (!current.canAskAgain) {
        void Linking.openSettings().catch(() => {})
      }
      return
    }
    handled.current = false
    setScanning(true)
  }

  if (scanning) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            // The camera reports the same code many times a second.
            if (!handled.current && parsePairingPayload(data)) {
              handled.current = true
              void pair(data)
            }
          }}
        />
        <View style={{ position: 'absolute', top: insets.top + space.sm, left: space.sm, right: space.sm, flexDirection: 'row', alignItems: 'center' }}>
          <IconButton icon={X} label="Stop scanning" tone="onAccent" onPress={() => setScanning(false)} style={{ backgroundColor: 'rgba(0,0,0,0.5)' }} />
        </View>
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + space.xxl, alignItems: 'center', paddingHorizontal: space.xl }}>
          <View style={{ backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md }}>
            <Txt size="small" style={{ color: '#ececee', textAlign: 'center' }}>
              Point the camera at the pairing code
            </Txt>
          </View>
        </View>
      </View>
    )
  }

  const shownError = error ?? storeError
  return (
    <Screen>
      {adding ? (
        <View style={{ paddingTop: space.sm, paddingHorizontal: space.sm, flexDirection: 'row' }}>
          <IconButton icon={X} label="Close" onPress={() => navigation.goBack()} />
        </View>
      ) : null}
      <ScrollView
        contentContainerStyle={{ padding: space.xl, paddingTop: adding ? space.lg : space.xxl * 1.5, gap: space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        <Mark />
        <View style={{ gap: space.sm }}>
          <Txt size="title" weight="semibold" accessibilityRole="header">
            {adding ? 'Pair another computer' : 'Pair with your computer'}
          </Txt>
          {adding ? (
            <Txt tone="text2">
              It is added to your computers and used from now on. Switch between them in Settings.
            </Txt>
          ) : null}
          <Txt tone="text2">
            Pi Remote controls Pi Desktop from your phone: start and follow chats, answer pi&apos;s questions, review and
            commit changes. The two talk directly over your network, end-to-end encrypted. On a server without the
            desktop app, run pi-remote there and scan the code from &quot;pi-remote pair&quot;.
          </Txt>
        </View>
        <View style={{ gap: space.md }}>
          {STEPS.map((step, index) => (
            <View key={step} style={{ flexDirection: 'row', gap: space.md }}>
              <Mono size={14} tone="muted">{`${index + 1}`}</Mono>
              <Txt style={{ flex: 1 }}>{step}</Txt>
            </View>
          ))}
        </View>
        {busy ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }} accessibilityLiveRegion="polite">
            <Pixel tone="working" />
            <Txt tone="text2">{`Connecting to ${busy}…`}</Txt>
          </View>
        ) : (
          <Button title="Scan pairing code" kind="primary" icon={ScanLine} onPress={() => void startScan()} testID="pair-scan" />
        )}
        {shownError ? (
          <View
            accessibilityRole="alert"
            style={{ borderLeftWidth: 2, borderLeftColor: theme.danger, paddingLeft: space.md, paddingVertical: space.xs }}
          >
            <Txt size="small" tone="danger">
              {shownError}
            </Txt>
          </View>
        ) : null}
        <View style={{ gap: space.sm }}>
          <Txt size="small" tone="muted">
            No camera? Choose &quot;Copy pairing link&quot; on the computer, send it to this phone and paste it here.
          </Txt>
          <Field
            value={link}
            onChangeText={setLink}
            placeholder="pidesktop://pair?…"
            accessibilityLabel="Pairing link"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button
              title="Paste"
              icon={ClipboardPaste}
              style={{ flex: 1 }}
              onPress={() => void Clipboard.getStringAsync().then((text) => setLink(text.trim()))}
            />
            <Button title="Pair" style={{ flex: 1 }} disabled={!link.trim() || busy !== null} onPress={() => void pair(link)} />
          </View>
        </View>
        <Txt size="caption" tone="muted">
          Both devices need to reach each other: the same Wi-Fi, or a VPN such as Tailscale.
        </Txt>
      </ScrollView>
    </Screen>
  )
}
