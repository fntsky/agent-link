package dev.dshremote.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder

/**
 * Keeps the app process in the foreground while a Relay connection is desired.
 * The foreground service does not own the WebSocket; it prevents the OS from
 * suspending the process that owns RelayClient/ViewModel.
 */
class RelayKeepAliveService : Service() {
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Relay connection", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps the DSH Remote connection alive in the background"
                setShowBadge(false)
            },
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, notification())
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_remote)
            .setContentTitle("DSH Remote")
            .setContentText("保持 Relay 连接")
            .setContentIntent(open)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "relay-keepalive"
        private const val NOTIFICATION_ID = 4101

        fun start(context: Context) {
            try {
                context.startForegroundService(Intent(context, RelayKeepAliveService::class.java))
            } catch (_: Exception) {
                // Foreground-service start can be refused while the app is not
                // visible; the connection itself still works when the app is.
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RelayKeepAliveService::class.java))
        }
    }
}
