package io.github.azygoss.piremote.background

import android.content.Context
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** JS surface of the keep-alive service and the app's notifications. */
class PiRemoteBackgroundModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("PiRemoteBackground")

    /** Whether the user lets this app post notifications at all. */
    Function("notificationsAllowed") {
      NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /** Start the keep-alive service or update its text; false when refused. */
    Function("startKeepAlive") { title: String, text: String ->
      KeepAliveService.start(context, title, text)
    }

    Function("stopKeepAlive") { KeepAliveService.stop(context) }

    Function("keepAliveRunning") { KeepAliveService.running }

    /** Post (or replace) the notification for `tag`; `link` opens on tap. */
    Function("notify") { tag: String, title: String, body: String, link: String ->
      Notifications.alert(context, tag, title, body, link)
    }

    Function("cancel") { tag: String -> Notifications.cancel(context, tag) }

    Function("cancelAlerts") { Notifications.cancelAlerts(context) }

    /** The link the app was opened with, if it starts with `prefix` (once). */
    Function("takeLaunchLink") { prefix: String -> LaunchLink.take(prefix) }
  }
}
