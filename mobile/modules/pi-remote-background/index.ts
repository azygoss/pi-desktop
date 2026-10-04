import { requireOptionalNativeModule } from 'expo'

interface PiRemoteBackgroundModule {
  /** Whether the user lets this app post notifications at all. */
  notificationsAllowed(): boolean
  /** Start the keep-alive service or update its text; false when Android refuses. */
  startKeepAlive(title: string, text: string): boolean
  stopKeepAlive(): void
  keepAliveRunning(): boolean
  /** Post (or replace) the notification for `tag`; `link` opens when it is tapped. */
  notify(tag: string, title: string, body: string, link: string): void
  cancel(tag: string): void
  cancelAlerts(): void
  /**
   * The `pidesktop://` link the app was opened with, if it starts with
   * `prefix`; returned once. Unlike `Linking`, it survives the app's process
   * being restarted to deliver it.
   */
  takeLaunchLink(prefix: string): string | null
}

/** The headless task the keep-alive service runs (see KeepAliveService.kt). */
export const KEEP_ALIVE_TASK = 'PiRemoteKeepAlive'

/** Null where the native module is not built in (another platform). */
export const Background = requireOptionalNativeModule<PiRemoteBackgroundModule>('PiRemoteBackground')
