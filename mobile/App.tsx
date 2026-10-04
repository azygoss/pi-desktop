// One import per weight: the package index would bundle all fourteen files.
import { IBMPlexMono_400Regular } from '@expo-google-fonts/ibm-plex-mono/400Regular'
import { IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono/500Medium'
import { IBMPlexMono_600SemiBold } from '@expo-google-fonts/ibm-plex-mono/600SemiBold'
import { createNavigationContainerRef, DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { useFonts } from 'expo-font'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import * as SystemUI from 'expo-system-ui'
import { useEffect, useMemo } from 'react'
import { AppState, Linking } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import type { RootStackParamList } from './src/nav'
import { AutomationEditScreen } from './src/screens/AutomationEditScreen'
import { ChatScreen } from './src/screens/ChatScreen'
import { DiffScreen } from './src/screens/DiffScreen'
import { FileScreen } from './src/screens/FileScreen'
import { FolderPickerScreen } from './src/screens/FolderPickerScreen'
import { HomeScreen } from './src/screens/HomeScreen'
import { PairScreen } from './src/screens/PairScreen'
import { PrScreen } from './src/screens/PrScreen'
import { SideChatScreen } from './src/screens/SideChatScreen'
import { UsageScreen } from './src/screens/UsageScreen'
import { initBackground, openChatLink, takeLaunchLink } from './src/lib/background'
import { initChatBridge, setOpenChatHandler, useChats } from './src/state/chats'
import { useConnection } from './src/state/connection'
import { initDataBridge } from './src/state/data'
import { usePrefs } from './src/state/prefs'
import { useTheme } from './src/theme'
import { ToastHost } from './src/ui'

void SplashScreen.preventAutoHideAsync().catch(() => {})

const Stack = createNativeStackNavigator<RootStackParamList>()
const navigationRef = createNavigationContainerRef<RootStackParamList>()

// The bridges listen for the whole life of the app; wire them before the
// first connection so no broadcast is missed.
initDataBridge()
initChatBridge()
initBackground()

/** A chat asked for before the navigator was up (a cold start from a notification). */
let pendingChat: string | null = null

function showChat(chatId: string): void {
  if (navigationRef.isReady()) {
    navigationRef.navigate('Chat', { chatId })
  } else {
    pendingChat = chatId
  }
}

/** The launch URL is looked at once for a pairing link (it stays the same all session). */
let initialPairLinkSeen = false

/** A pairing link that arrived while paired, before the navigator was up. */
let pendingPair: string | null = null

/**
 * A pairing link while a computer is already paired: pair one more. (Without
 * any pairing the Pair screen is up and takes the link itself.)
 */
function openPairLink(url: string | null): boolean {
  if (!url?.startsWith('pidesktop://pair') || !useConnection.getState().pairing) {
    return false
  }
  if (navigationRef.isReady()) {
    navigationRef.navigate('AddComputer', { link: url })
  } else {
    pendingPair = url
  }
  return true
}

function showPendingChat(): void {
  const link = pendingPair
  pendingPair = null
  if (link) {
    navigationRef.navigate('AddComputer', { link })
    return
  }
  const chatId = pendingChat
  pendingChat = null
  if (chatId && useChats.getState().chats[chatId]) {
    navigationRef.navigate('Chat', { chatId })
  }
}
setOpenChatHandler((chatId) => {
  if (navigationRef.isReady() && useChats.getState().chats[chatId]) {
    navigationRef.navigate('Chat', { chatId })
  }
})

export default function App() {
  const theme = useTheme()
  const [fontsLoaded, fontError] = useFonts({
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
    IBMPlexMono_600SemiBold
  })
  const prefsLoaded = usePrefs((s) => s.loaded)
  const phase = useConnection((s) => s.phase)
  const paired = useConnection((s) => s.pairing !== null)

  useEffect(() => {
    void usePrefs.getState().load()
    void useConnection.getState().init()
  }, [])

  // A tapped notification opens the app on its chat.
  useEffect(() => {
    // The native side keeps the link when the process was restarted for it
    // (JS was not listening yet); `Linking` covers the rest.
    const fromLaunch = (): boolean => {
      if (useConnection.getState().pairing) {
        const pairLink = takeLaunchLink('pidesktop://pair')
        if (pairLink && openPairLink(pairLink)) {
          return true
        }
      }
      return openChatLink(takeLaunchLink('pidesktop://chat'), showChat)
    }
    if (!fromLaunch()) {
      void Linking.getInitialURL()
        .then((url) => openPairLink(url) || openChatLink(url, showChat))
        .catch(() => {})
    }
    const subscription = Linking.addEventListener('url', (event) => {
      takeLaunchLink('pidesktop://chat') // the same link, delivered live
      if (useConnection.getState().pairing) {
        takeLaunchLink('pidesktop://pair')
      }
      if (!openPairLink(event.url)) {
        openChatLink(event.url, showChat)
      }
    })
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        fromLaunch()
      }
    })
    return () => {
      subscription.remove()
      appState.remove()
    }
  }, [])

  // A pairing link that launched the app: once the stored pairings are read
  // it is known whether the Pair screen (first pairing) or AddComputer takes it.
  const loaded = phase !== 'loading'
  useEffect(() => {
    if (!loaded || !useConnection.getState().pairing) {
      return
    }
    if (!openPairLink(takeLaunchLink('pidesktop://pair'))) {
      void Linking.getInitialURL()
        .then((url) => {
          if (url && !initialPairLinkSeen) {
            initialPairLinkSeen = true
            openPairLink(url)
          }
        })
        .catch(() => {})
    }
  }, [loaded])

  const ready = (fontsLoaded || fontError !== null) && prefsLoaded && phase !== 'loading'
  useEffect(() => {
    if (ready) {
      void SplashScreen.hideAsync().catch(() => {})
    }
  }, [ready])

  // The window behind the views: no white flash on keyboard or navigation.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(theme.bg).catch(() => {})
  }, [theme.bg])

  const navTheme = useMemo(() => {
    const base = theme.dark ? DarkTheme : DefaultTheme
    return {
      ...base,
      colors: {
        ...base.colors,
        background: theme.bg,
        card: theme.bg,
        text: theme.text,
        border: theme.border,
        primary: theme.accent
      }
    }
  }, [theme])

  if (!ready) {
    return null
  }
  return (
    <SafeAreaProvider>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <NavigationContainer ref={navigationRef} theme={navTheme} onReady={showPendingChat}>
        <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
          {paired ? (
            <>
              <Stack.Screen name="Home" component={HomeScreen} />
              {/* One screen per chat: opening another chat never reuses the
                  mounted one (and its half-typed message). */}
              <Stack.Screen name="Chat" component={ChatScreen} getId={({ params }) => params.chatId} />
              <Stack.Screen name="Diff" component={DiffScreen} />
              <Stack.Screen name="Pr" component={PrScreen} />
              <Stack.Screen name="File" component={FileScreen} />
              <Stack.Screen name="Side" component={SideChatScreen} />
              <Stack.Screen name="AutomationEdit" component={AutomationEditScreen} />
              <Stack.Screen name="Usage" component={UsageScreen} />
              <Stack.Screen name="FolderPicker" component={FolderPickerScreen} />
              <Stack.Screen name="AddComputer" component={PairScreen} options={{ animation: 'slide_from_bottom' }} />
            </>
          ) : (
            <Stack.Screen name="Pair" component={PairScreen} options={{ animation: 'fade' }} />
          )}
        </Stack.Navigator>
      </NavigationContainer>
      <ToastHost />
    </SafeAreaProvider>
  )
}
