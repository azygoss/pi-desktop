import { useMemo } from 'react'
import { StyleSheet, useColorScheme } from 'react-native'

import { usePrefs } from '../state/prefs'

/**
 * Pi Desktop's design language on a phone (see docs/design.md in the repo):
 * color is signal — blue = pi is working / active, amber = pi needs you,
 * coral = error or stop — and everything else is ink on graphite (dark) or
 * paper (light). Readouts use IBM Plex Mono; status marks are square pixels.
 * Every text color meets WCAG AA on the surfaces it is used on.
 */
export interface Theme {
  dark: boolean
  /** Window frame: behind the lists and the tab bar. */
  chrome: string
  /** The sheet content sits on. */
  bg: string
  surface: string
  raised: string
  pressed: string
  active: string
  border: string
  borderStrong: string
  codeBg: string
  text: string
  text2: string
  muted: string
  /** Decorative only (empty cells, rules) — never text. */
  faint: string
  accent: string
  onAccent: string
  accentSoft: string
  danger: string
  dangerSoft: string
  success: string
  successSoft: string
  warning: string
  warningSoft: string
  userBlock: string
  scrim: string
  sigils: string[]
}

const dark: Theme = {
  dark: true,
  chrome: '#0e0f11',
  bg: '#141517',
  surface: '#1a1b1e',
  raised: '#1f2023',
  pressed: '#222327',
  active: '#292a2f',
  border: '#242529',
  borderStrong: '#33343a',
  codeBg: '#111214',
  text: '#ececee',
  text2: '#b4b5ba',
  muted: '#8a8b91',
  faint: '#45464c',
  accent: '#62b0dc',
  onAccent: '#06121b',
  accentSoft: 'rgba(98,176,220,0.14)',
  danger: '#f09082',
  dangerSoft: 'rgba(240,144,130,0.13)',
  success: '#77c690',
  successSoft: 'rgba(119,198,144,0.13)',
  warning: '#e9b04e',
  warningSoft: 'rgba(233,176,78,0.13)',
  userBlock: '#1c1d20',
  scrim: 'rgba(0,0,0,0.55)',
  sigils: ['#f09082', '#62b0dc', '#e9b04e', '#86c79a', '#b59cf0', '#6fc6c0']
}

const light: Theme = {
  dark: false,
  chrome: '#ecece9',
  bg: '#fbfbfa',
  surface: '#ffffff',
  raised: '#ffffff',
  pressed: '#f1f1ee',
  active: '#e7e7e3',
  border: '#e7e7e3',
  borderStrong: '#d4d4cf',
  codeBg: '#f5f5f2',
  text: '#16171a',
  text2: '#46474c',
  muted: '#6a6b70',
  faint: '#c8c8c3',
  accent: '#2a77aa',
  onAccent: '#ffffff',
  accentSoft: 'rgba(42,119,170,0.1)',
  danger: '#b8463a',
  dangerSoft: 'rgba(184,70,58,0.09)',
  success: '#2c8445',
  successSoft: 'rgba(44,132,69,0.1)',
  warning: '#8f6210',
  warningSoft: 'rgba(143,98,16,0.1)',
  userBlock: '#f3f3f0',
  scrim: 'rgba(20,20,18,0.35)',
  sigils: ['#d9604f', '#2f86bd', '#c98a14', '#3f9a5c', '#7d5fd0', '#2a9a93']
}

export const fonts = {
  mono: 'IBMPlexMono_400Regular',
  monoMedium: 'IBMPlexMono_500Medium',
  monoSemi: 'IBMPlexMono_600SemiBold'
} as const

/** 4pt spacing scale. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const
export const radius = { pixel: 2, sm: 6, md: 10, lg: 14 } as const
/** Smallest comfortable touch target (Material: 48dp). */
export const TOUCH = 48

export function useTheme(): Theme {
  const system = useColorScheme()
  const pref = usePrefs((s) => s.theme)
  const isDark = pref === 'system' ? system !== 'light' : pref === 'dark'
  return isDark ? dark : light
}

/** Theme-dependent styles, built once per theme. */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (theme: Theme) => T
): () => T {
  const cache = new Map<Theme, T>()
  return function useStyles(): T {
    const theme = useTheme()
    return useMemo(() => {
      let styles = cache.get(theme)
      if (!styles) {
        styles = StyleSheet.create(factory(theme))
        cache.set(theme, styles)
      }
      return styles
    }, [theme])
  }
}
