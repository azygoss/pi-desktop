package io.github.azygoss.piremote.background

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/**
 * The link the app was opened with (a tapped notification, a scanned pairing
 * code), kept until JS asks for it. When Android restarts the app's process
 * to deliver such a link, it arrives before JS is listening and React
 * Native's own `Linking` drops it; this does not.
 */
internal object LaunchLink {
  private const val SCHEME = "pidesktop://"

  @Volatile private var link: String? = null

  fun offer(intent: Intent?) {
    val data = intent?.dataString ?: return
    if (data.startsWith(SCHEME)) {
      link = data
    }
  }

  /** The stored link if it starts with `prefix`; taking it forgets it. */
  @Synchronized
  fun take(prefix: String): String? {
    val current = link
    if (current == null || !current.startsWith(prefix)) {
      return null
    }
    link = null
    return current
  }
}

class PiRemoteBackgroundPackage : Package {
  override fun createReactActivityLifecycleListeners(
    activityContext: Context
  ): List<ReactActivityLifecycleListener> =
    listOf(
      object : ReactActivityLifecycleListener {
        override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
          // A restored activity is re-created with its old intent: only a
          // fresh launch carries a link worth keeping.
          if (savedInstanceState == null) {
            LaunchLink.offer(activity.intent)
          }
        }

        override fun onNewIntent(intent: Intent): Boolean {
          LaunchLink.offer(intent)
          return false
        }
      }
    )
}
