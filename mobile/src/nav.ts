import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack'

/** Every screen of the app and what it is opened with. */
export type RootStackParamList = {
  Pair: undefined
  Home: undefined
  Chat: { chatId: string }
  /** Working-tree changes of a project: review, commit, push. */
  Diff: { cwd: string; chatId?: string }
  /** The pull request of the project's branch. */
  Pr: { cwd: string; chatId?: string }
  /** A text file inside a project folder (read-only). */
  File: { cwd: string; path: string }
  /** A side chat: questions with the chat's context that leave nothing in it. */
  Side: { chatId: string; question?: string }
  AutomationEdit: { id?: string }
  Usage: undefined
  /** Browse folders on the computer; resolves through lib/folder-pick. */
  FolderPicker: { title: string }
}

export type Nav = NativeStackNavigationProp<RootStackParamList>
export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<
  RootStackParamList,
  T
>
