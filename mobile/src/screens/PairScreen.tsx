import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Clipboard from 'expo-clipboard'
import { ClipboardPaste, ScanLine, X } from 'lucide-react-native'
import { useRef, useState } from 'react'
import { Linking, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { parsePairingPayload } from '../desktop'
import { errorText } from '../remote/api'
import { useConnection } from '../state/connection'
import { radius, space, useTheme } from '../theme'
import { Button, Field, haptic, IconButton, Mono, Pixel, Screen, Txt } from '../ui'

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
 * First run: pair this phone with a computer by scanning the one-time QR
 * code Pi Desktop shows (or pasting its link).
 */
export function PairScreen() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
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
    } catch (e) {
      haptic('warning')
      setError(useConnection.getState().error ?? errorText(e))
    } finally {
      setBusy(null)
      handled.current = false
    }
  }

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
              Point the camera at the pairing code in Pi Desktop
            </Txt>
          </View>
        </View>
      </View>
    )
  }

  const shownError = error ?? storeError
  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: space.xl, paddingTop: space.xxl * 1.5, gap: space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        <Mark />
        <View style={{ gap: space.sm }}>
          <Txt size="title" weight="semibold" accessibilityRole="header">
            Pair with your computer
          </Txt>
          <Txt tone="text2">
            Pi Remote controls Pi Desktop from your phone: start and follow chats, answer pi&apos;s questions, review and
            commit changes. The two talk directly over your network, end-to-end encrypted.
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
