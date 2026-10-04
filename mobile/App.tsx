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
      <NavigationContainer ref={navigationRef} theme={navTheme}>
        <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
          {paired ? (
            <>
              <Stack.Screen name="Home" component={HomeScreen} />
              <Stack.Screen name="Chat" component={ChatScreen} />
              <Stack.Screen name="Diff" component={DiffScreen} />
              <Stack.Screen name="Pr" component={PrScreen} />
              <Stack.Screen name="File" component={FileScreen} />
              <Stack.Screen name="Side" component={SideChatScreen} />
              <Stack.Screen name="AutomationEdit" component={AutomationEditScreen} />
              <Stack.Screen name="Usage" component={UsageScreen} />
              <Stack.Screen name="FolderPicker" component={FolderPickerScreen} />
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
