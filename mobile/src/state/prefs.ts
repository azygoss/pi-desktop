import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'

export type ThemePref = 'system' | 'light' | 'dark'

interface PrefsState {
  theme: ThemePref
  haptics: boolean
  /** Background notifications: null until the user has been asked. */
  notifications: boolean | null
  loaded: boolean
  load(): Promise<void>
  set(patch: Partial<Pick<PrefsState, 'theme' | 'haptics' | 'notifications'>>): void
}

const KEY = 'pi-remote.prefs'

/** This phone's own preferences (nothing here reaches the computer). */
export const usePrefs = create<PrefsState>((set, get) => ({
  theme: 'system',
  haptics: true,
  notifications: null,
  loaded: false,

  async load() {
    try {
      const raw = await AsyncStorage.getItem(KEY)
      const stored = raw ? (JSON.parse(raw) as Partial<PrefsState>) : {}
      set({
        theme:
          stored.theme === 'light' || stored.theme === 'dark' || stored.theme === 'system'
            ? stored.theme
            : 'system',
        haptics: stored.haptics !== false,
        notifications: typeof stored.notifications === 'boolean' ? stored.notifications : null,
        loaded: true
      })
    } catch {
      set({ loaded: true })
    }
  },

  set(patch) {
    set(patch)
    const { theme, haptics, notifications } = get()
    void AsyncStorage.setItem(KEY, JSON.stringify({ theme, haptics, notifications })).catch(() => {})
  }
}))
