import * as Haptics from 'expo-haptics'
import { ChevronLeft, type LucideIcon } from 'lucide-react-native'
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { create } from 'zustand'

import { sigilPattern } from '../desktop'
import { useTick } from '../lib/live-clock'
import { usePrefs } from '../state/prefs'
import { fonts, makeStyles, radius, space, TOUCH, useTheme, type Theme } from '../theme'

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

type Tone = 'text' | 'text2' | 'muted' | 'accent' | 'danger' | 'warning' | 'success' | 'onAccent'

interface TxtProps extends TextProps {
  /** body 16 · small 14 · caption 13 · title 20 · heading 17 */
  size?: 'body' | 'small' | 'caption' | 'title' | 'heading'
  tone?: Tone
  weight?: 'regular' | 'medium' | 'semibold'
}

const SIZES: Record<NonNullable<TxtProps['size']>, TextStyle> = {
  body: { fontSize: 16, lineHeight: 24 },
  small: { fontSize: 14, lineHeight: 20 },
  caption: { fontSize: 13, lineHeight: 18 },
  heading: { fontSize: 17, lineHeight: 24 },
  title: { fontSize: 22, lineHeight: 28 }
}
const WEIGHTS = { regular: '400', medium: '500', semibold: '600' } as const

/** Prose, titles and controls: the system face. */
export function Txt({ size = 'body', tone = 'text', weight = 'regular', style, ...rest }: TxtProps) {
  const theme = useTheme()
  return (
    <Text
      {...rest}
      style={[SIZES[size], { color: theme[tone], fontWeight: WEIGHTS[weight] }, style]}
    />
  )
}

interface MonoProps extends TextProps {
  size?: number
  tone?: Tone
  weight?: 'regular' | 'medium' | 'semibold'
}

const MONO_FACES = { regular: fonts.mono, medium: fonts.monoMedium, semibold: fonts.monoSemi }

/** Readouts — times, tokens, models, tool names, paths, code: IBM Plex Mono. */
export function Mono({ size = 13, tone = 'text2', weight = 'regular', style, ...rest }: MonoProps) {
  const theme = useTheme()
  return (
    <Text
      {...rest}
      style={[
        {
          fontFamily: MONO_FACES[weight],
          fontSize: size,
          lineHeight: Math.round(size * 1.45),
          color: theme[tone],
          fontVariant: ['tabular-nums']
        },
        style
      ]}
    />
  )
}

export function SectionLabel({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return (
    <Txt size="caption" tone="muted" weight="medium" style={[{ marginBottom: space.sm }, style]}>
      {children}
    </Txt>
  )
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

export type PixelTone = 'working' | 'attention' | 'error' | 'unread' | 'ok' | 'idle'

/**
 * A square status mark. `working` is hollow blue and blinks on the shared
 * 1 Hz clock (never an animation loop); the others are solid.
 */
export const Pixel = memo(function Pixel({ tone, size = 8 }: { tone: PixelTone; size?: number }) {
  const theme = useTheme()
  const tick = useTick(tone === 'working')
  const color =
    tone === 'attention'
      ? theme.warning
      : tone === 'error'
        ? theme.danger
        : tone === 'ok'
          ? theme.success
          : tone === 'idle'
            ? theme.faint
            : theme.accent
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius.pixel,
        borderWidth: tone === 'working' ? 1.5 : 0,
        borderColor: color,
        backgroundColor: tone === 'working' ? 'transparent' : color,
        opacity: tone === 'working' && tick % 2 === 1 ? 0.35 : 1
      }}
    />
  )
})

/** A project's 3×3 pixel sigil, derived from its path. */
export const Sigil = memo(function Sigil({ seed, size = 18 }: { seed: string; size?: number }) {
  const theme = useTheme()
  const { cells, hue } = sigilPattern(seed)
  const gap = Math.max(1, Math.round(size / 12))
  const cell = (size - gap * 2) / 3
  return (
    <View style={{ width: size, height: size, flexDirection: 'row', flexWrap: 'wrap', gap }}>
      {cells.map((on, i) => (
        <View
          key={i}
          style={{
            width: cell,
            height: cell,
            borderRadius: 1,
            backgroundColor: on ? theme.sigils[hue] : 'transparent'
          }}
        />
      ))}
    </View>
  )
})

/** Chats without a project: a dashed square. */
export function ScratchSigil({ size = 18 }: { size?: number }) {
  const theme = useTheme()
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 3,
        borderWidth: 1.5,
        borderStyle: 'dashed',
        borderColor: theme.muted
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Touch
// ---------------------------------------------------------------------------

export function haptic(kind: 'tap' | 'success' | 'warning' = 'tap'): void {
  if (!usePrefs.getState().haptics) {
    return
  }
  if (kind === 'tap') {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
  } else {
    void Haptics.notificationAsync(
      kind === 'success'
        ? Haptics.NotificationFeedbackType.Success
        : Haptics.NotificationFeedbackType.Warning
    ).catch(() => {})
  }
}

interface TapProps extends Omit<PressableProps, 'style'> {
  style?: StyleProp<ViewStyle>
  /** Screen-reader name; required for icon-only controls. */
  label?: string
  children?: ReactNode
}

/** Pressable with the theme's ripple and an accessible role. */
export function Tap({ style, label, children, disabled, ...rest }: TapProps) {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      android_ripple={{ color: theme.active }}
      disabled={disabled}
      {...rest}
      style={[style, disabled ? { opacity: 0.45 } : null]}
    >
      {children}
    </Pressable>
  )
}

export function IconButton({
  icon: Icon,
  label,
  onPress,
  tone = 'text2',
  size = 20,
  disabled,
  style
}: {
  icon: LucideIcon
  label: string
  onPress?: () => void
  tone?: Tone
  size?: number
  disabled?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const theme = useTheme()
  return (
    <View style={[{ width: TOUCH, height: TOUCH, borderRadius: TOUCH / 2, overflow: 'hidden' }, style]}>
      <Tap
        label={label}
        onPress={onPress}
        disabled={disabled}
        hitSlop={4}
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon size={size} color={theme[tone]} strokeWidth={1.75} />
      </Tap>
    </View>
  )
}

export function Button({
  title,
  onPress,
  kind = 'secondary',
  icon: Icon,
  disabled,
  busy,
  style,
  testID
}: {
  title: string
  onPress?: () => void
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost'
  icon?: LucideIcon
  disabled?: boolean
  /** In flight: disabled, with the label dimmed (no spinner — no loops). */
  busy?: boolean
  style?: StyleProp<ViewStyle>
  testID?: string
}) {
  const theme = useTheme()
  const background =
    kind === 'primary' ? theme.accent : kind === 'danger' ? theme.dangerSoft : kind === 'ghost' ? 'transparent' : theme.surface
  const color: Tone = kind === 'primary' ? 'onAccent' : kind === 'danger' ? 'danger' : 'text'
  return (
    <View
      style={[
        {
          borderRadius: radius.md,
          overflow: 'hidden',
          backgroundColor: background,
          borderWidth: kind === 'secondary' ? StyleSheet.hairlineWidth : 0,
          borderColor: theme.borderStrong
        },
        style
      ]}
    >
      <Tap
        testID={testID}
        onPress={onPress}
        disabled={disabled || busy}
        style={{
          minHeight: TOUCH,
          paddingHorizontal: space.lg,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: space.sm
        }}
      >
        {Icon ? <Icon size={17} color={theme[color]} strokeWidth={1.9} /> : null}
        <Txt size="small" weight="semibold" tone={color}>
          {busy ? `${title}…` : title}
        </Txt>
      </Tap>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const useLayoutStyles = makeStyles((t: Theme) => ({
  screen: { flex: 1, backgroundColor: t.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: t.border,
    backgroundColor: t.bg
  },
  headerTitle: { flex: 1, paddingHorizontal: space.sm, justifyContent: 'center' },
  row: {
    minHeight: 56,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginLeft: space.lg },
  input: {
    minHeight: TOUCH,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.borderStrong,
    backgroundColor: t.surface,
    color: t.text,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: 16
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: t.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.borderStrong,
    padding: 3
  },
  segment: { flex: 1, minHeight: 40, borderRadius: radius.md - 3, overflow: 'hidden' },
  segmentTap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.sm },
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: t.scrim },
  sheet: {
    backgroundColor: t.raised,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.borderStrong,
    maxHeight: '88%'
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: t.faint,
    marginTop: space.sm,
    marginBottom: space.xs
  },
  sheetTitle: { paddingHorizontal: space.lg, paddingVertical: space.md },
  toast: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    backgroundColor: t.dark ? '#2b2c31' : '#26272b',
    borderRadius: radius.md,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    minHeight: TOUCH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.md }
}))

/** A screen: safe-area aware, with an optional header bar. */
export function Screen({
  title,
  subtitle,
  onBack,
  right,
  children,
  header,
  bottomInset = true
}: {
  title?: string
  subtitle?: string
  onBack?: () => void
  right?: ReactNode
  /** Replaces the default title block. */
  header?: ReactNode
  children: ReactNode
  /** Pad the bottom by the gesture bar (off when the screen handles it). */
  bottomInset?: boolean
}) {
  const styles = useLayoutStyles()
  const insets = useSafeAreaInsets()
  const showHeader = title !== undefined || header !== undefined
  return (
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top, paddingBottom: bottomInset ? insets.bottom : 0 }
      ]}
    >
      {showHeader ? (
        <View style={styles.header}>
          {onBack ? <IconButton icon={ChevronLeft} label="Back" onPress={onBack} size={24} /> : null}
          {header ?? (
            <View style={[styles.headerTitle, onBack ? null : { paddingLeft: space.md }]}>
              <Txt size="heading" weight="semibold" numberOfLines={1} accessibilityRole="header">
                {title}
              </Txt>
              {subtitle ? (
                <Mono size={12} tone="muted" numberOfLines={1}>
                  {subtitle}
                </Mono>
              ) : null}
            </View>
          )}
          {right}
        </View>
      ) : null}
      {children}
    </View>
  )
}

export function Row({
  title,
  detail,
  left,
  right,
  onPress,
  onLongPress,
  danger,
  testID
}: {
  title: string
  detail?: string
  left?: ReactNode
  right?: ReactNode
  onPress?: () => void
  onLongPress?: () => void
  danger?: boolean
  testID?: string
}) {
  const styles = useLayoutStyles()
  const body = (
    <>
      {left}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt tone={danger ? 'danger' : 'text'} numberOfLines={1}>
          {title}
        </Txt>
        {detail ? (
          <Txt size="caption" tone="muted" numberOfLines={2}>
            {detail}
          </Txt>
        ) : null}
      </View>
      {right}
    </>
  )
  if (!onPress && !onLongPress) {
    return <View style={styles.row}>{body}</View>
  }
  return (
    <Tap testID={testID} onPress={onPress} onLongPress={onLongPress} style={styles.row}>
      {body}
    </Tap>
  )
}

export function Divider() {
  return <View style={useLayoutStyles().divider} />
}

export function Field({ style, ...rest }: TextInputProps) {
  const styles = useLayoutStyles()
  const theme = useTheme()
  return (
    <TextInput
      placeholderTextColor={theme.muted}
      selectionColor={theme.accent}
      cursorColor={theme.accent}
      {...rest}
      style={[styles.input, style]}
    />
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange(value: T): void
}) {
  const styles = useLayoutStyles()
  const theme = useTheme()
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((option) => {
        const selected = option.value === value
        return (
          <View
            key={option.value}
            style={[styles.segment, selected ? { backgroundColor: theme.active } : null]}
          >
            <Tap
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => onChange(option.value)}
              style={styles.segmentTap}
            >
              <Txt size="small" weight={selected ? 'semibold' : 'regular'} tone={selected ? 'text' : 'text2'}>
                {option.label}
              </Txt>
            </Tap>
          </View>
        )
      })}
    </View>
  )
}

export function Empty({
  icon: Icon,
  title,
  detail,
  action
}: {
  icon?: LucideIcon
  title: string
  detail?: string
  action?: ReactNode
}) {
  const styles = useLayoutStyles()
  const theme = useTheme()
  return (
    <View style={styles.empty}>
      {Icon ? <Icon size={28} color={theme.muted} strokeWidth={1.5} /> : null}
      <Txt weight="semibold" style={{ textAlign: 'center' }}>
        {title}
      </Txt>
      {detail ? (
        <Txt size="small" tone="muted" style={{ textAlign: 'center' }}>
          {detail}
        </Txt>
      ) : null}
      {action}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

/**
 * A bottom sheet: rises once over 180ms, closes on the scrim, the back
 * gesture or a swipe of the handle area. Content scrolls inside it.
 */
export function Sheet({
  visible,
  onClose,
  title,
  children,
  scroll = true
}: {
  visible: boolean
  onClose(): void
  title?: string
  children: ReactNode
  /** Wrap the content in a ScrollView (off for sheets with their own list). */
  scroll?: boolean
}) {
  const styles = useLayoutStyles()
  const insets = useSafeAreaInsets()
  const rise = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (visible) {
      rise.setValue(0)
      Animated.timing(rise, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true
      }).start()
    }
  }, [visible, rise])
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable
          style={styles.sheetBackdrop}
          onPress={onClose}
          accessibilityLabel="Close"
          accessibilityRole="button"
        >
          <Animated.View
            style={[
              styles.sheet,
              {
                paddingBottom: insets.bottom + space.sm,
                transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }]
              }
            ]}
          >
            {/* Swallow presses so taps inside the sheet do not close it. It
                must be allowed to shrink, or a long sheet never scrolls. */}
            <Pressable onPress={() => {}} accessible={false} style={{ flexShrink: 1 }}>
              <View style={styles.sheetHandle} />
              {title ? (
                <View style={styles.sheetTitle}>
                  <Txt size="heading" weight="semibold" accessibilityRole="header">
                    {title}
                  </Txt>
                </View>
              ) : null}
              {scroll ? (
                <ScrollView keyboardShouldPersistTaps="handled" bounces={false} style={{ flexShrink: 1 }}>
                  {children}
                </ScrollView>
              ) : (
                children
              )}
            </Pressable>
          </Animated.View>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  )
}

/** A row of a menu sheet. */
export function SheetAction({
  icon: Icon,
  title,
  detail,
  onPress,
  danger,
  selected
}: {
  icon?: LucideIcon
  title: string
  detail?: string
  onPress(): void
  danger?: boolean
  selected?: boolean
}) {
  const theme = useTheme()
  return (
    <Row
      title={title}
      detail={detail}
      danger={danger}
      onPress={onPress}
      left={
        Icon ? (
          <Icon size={19} color={danger ? theme.danger : theme.text2} strokeWidth={1.75} />
        ) : undefined
      }
      right={selected ? <Pixel tone="unread" /> : undefined}
    />
  )
}

// ---------------------------------------------------------------------------
// Toasts and confirms
// ---------------------------------------------------------------------------

interface ToastState {
  current: { id: number; text: string; action?: { label: string; run(): void } } | null
}

const useToast = create<ToastState>(() => ({ current: null }))
let toastSeq = 0
let toastTimer: ReturnType<typeof setTimeout> | null = null

/** One line at the bottom of the screen, optionally with an action. */
export function toast(text: string, options?: { action?: { label: string; run(): void } }): void {
  if (toastTimer) {
    clearTimeout(toastTimer)
  }
  useToast.setState({ current: { id: ++toastSeq, text, action: options?.action } })
  toastTimer = setTimeout(() => useToast.setState({ current: null }), options?.action ? 6000 : 3500)
}

export function ToastHost() {
  const styles = useLayoutStyles()
  const insets = useSafeAreaInsets()
  const current = useToast((s) => s.current)
  const [keyboard, setKeyboard] = useState(0)
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => setKeyboard(e.endCoordinates.height))
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(0))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  if (!current) {
    return null
  }
  return (
    <View
      // Above the tab bar, or above the keyboard when it is up.
      style={[styles.toast, { bottom: keyboard > 0 ? keyboard + space.md : insets.bottom + 84 }]}
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
    >
      <Text style={{ flex: 1, color: '#ececee', fontSize: 14, lineHeight: 20, paddingVertical: space.sm }}>
        {current.text}
      </Text>
      {current.action ? (
        <Tap
          onPress={() => {
            current.action?.run()
            useToast.setState({ current: null })
          }}
          style={{ minHeight: TOUCH, minWidth: TOUCH, justifyContent: 'center', paddingHorizontal: space.md }}
        >
          <Text style={{ color: '#7cc0e6', fontSize: 14, fontWeight: '600' }}>{current.action.label}</Text>
        </Tap>
      ) : null}
    </View>
  )
}

/** A native confirm dialog; resolves true when the action button is chosen. */
export function confirm(options: {
  title: string
  message?: string
  action: string
  danger?: boolean
}): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      options.title,
      options.message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        {
          text: options.action,
          style: options.danger ? 'destructive' : 'default',
          onPress: () => resolve(true)
        }
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    )
  })
}
