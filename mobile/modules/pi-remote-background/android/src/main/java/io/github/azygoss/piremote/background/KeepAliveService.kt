package io.github.azygoss.piremote.background

import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Keeps the app's process — and with it the encrypted link to the computer —
 * alive while pi is working there, so the phone can say when it finishes.
 *
 * It is a foreground service with an ongoing "pi is working" notification,
 * and a headless JS task: React Native only runs timers in the background
 * while such a task is active, and the link needs them (heartbeat, redial).
 * The task ends when JS resolves it (nothing is running any more), which
 * stops the service.
 */
class KeepAliveService : HeadlessJsTaskService() {
  private var taskStarted = false

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "pi is working"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
    val notification = Notifications.keepAlive(this, title, text)
    try {
      ServiceCompat.startForeground(
        this,
        Notifications.KEEP_ALIVE_ID,
        notification,
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
          ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        } else {
          0
        }
      )
    } catch (_: Exception) {
      // Not allowed right now (started from the background): give up quietly.
      stopSelf()
      return START_NOT_STICKY
    }
    // Later starts only update the notification text.
    if (!taskStarted) {
      taskStarted = true
      super.onStartCommand(intent, flags, startId)
    }
    return START_NOT_STICKY
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    // No timeout: JS ends the task. Allowed while the app is on screen,
    // because that is when it has to start.
    HeadlessJsTaskConfig(TASK_NAME, Arguments.createMap(), 0, true)

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  companion object {
    const val TASK_NAME = "PiRemoteKeepAlive"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TEXT = "text"

    @Volatile var running = false
      private set

    /** Start the service, or update its notification when it is running. */
    fun start(context: Context, title: String, text: String): Boolean {
      val intent =
        Intent(context, KeepAliveService::class.java)
          .putExtra(EXTRA_TITLE, title)
          .putExtra(EXTRA_TEXT, text)
      return try {
        ContextCompat.startForegroundService(context, intent)
        running = true
        true
      } catch (_: Exception) {
        // Android refuses to start a foreground service from the background.
        false
      }
    }

    fun stop(context: Context) {
      running = false
      context.stopService(Intent(context, KeepAliveService::class.java))
    }
  }
}
