package io.github.azygoss.piremote.background

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/** Channels and builders for the app's two kinds of notification. */
internal object Notifications {
  /** The quiet, ongoing "pi is working" line of the keep-alive service. */
  const val CHANNEL_STATUS = "status"
  /** "pi finished" / "pi needs you": these may make a sound. */
  const val CHANNEL_ALERTS = "alerts"
  const val KEEP_ALIVE_ID = 1

  fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_STATUS, "Connection", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while pi is working on the computer"
        setShowBadge(false)
      }
    )
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ALERTS, "Chats", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "When pi finishes or needs your input"
      }
    )
  }

  private fun flags(): Int = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

  /** Opens the app; with a link, on the chat the notification is about. */
  private fun contentIntent(context: Context, link: String?, requestCode: Int): PendingIntent? {
    val intent =
      if (link.isNullOrEmpty()) {
        context.packageManager.getLaunchIntentForPackage(context.packageName)
      } else {
        Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(context.packageName)
      } ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(context, requestCode, intent, flags())
  }

  fun keepAlive(context: Context, title: String, text: String): Notification {
    ensureChannels(context)
    return NotificationCompat.Builder(context, CHANNEL_STATUS)
      .setSmallIcon(R.drawable.ic_pi_remote)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setContentIntent(contentIntent(context, null, KEEP_ALIVE_ID))
      .build()
  }

  fun alert(context: Context, tag: String, title: String, body: String, link: String) {
    ensureChannels(context)
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) {
      return
    }
    val notification =
      NotificationCompat.Builder(context, CHANNEL_ALERTS)
        .setSmallIcon(R.drawable.ic_pi_remote)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setAutoCancel(true)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setContentIntent(contentIntent(context, link, tag.hashCode()))
        .build()
    try {
      // One notification per chat: a newer one replaces the older.
      manager.notify(tag, 2, notification)
    } catch (_: SecurityException) {
      // The permission was revoked between the check and the post.
    }
  }

  fun cancel(context: Context, tag: String) {
    NotificationManagerCompat.from(context).cancel(tag, 2)
  }

  fun cancelAlerts(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    for (shown in manager.activeNotifications) {
      if (shown.id == 2) {
        manager.cancel(shown.tag, shown.id)
      }
    }
  }
}
