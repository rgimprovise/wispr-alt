package app.agolos

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

/**
 * Long-running foreground service. Keeps А-ГОЛОС alive in the background
 * so the QS tile, notification action, and (future) Accessibility-service
 * gesture triggers can pop the overlay without re-launching the app.
 *
 * Lifecycle:
 *   - Started by MainActivity when the user enables А-ГОЛОС.
 *   - Posts a persistent notification with a "Dictate" action.
 *   - On ACTION_DICTATE intent (from tile / notification / Activity / a11y),
 *     spins up the OverlayController which handles UI + recording.
 */
class WisprService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var overlay: OverlayController? = null

    override fun onBind(intent: Intent?): IBinder? = LocalBinder()

    inner class LocalBinder : Binder() {
        fun service(): WisprService = this@WisprService
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        Log.i(TAG, "service created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureNotificationChannel()
        startForeground(NOTIF_ID, buildNotification())

        when (intent?.action) {
            ACTION_DICTATE -> popOverlay()
            ACTION_STOP -> {
                hideOverlay()
                stopSelf()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        Log.i(TAG, "service destroyed")
        hideOverlay()
        scope.cancel()
        instance = null
        super.onDestroy()
    }

    private fun ensureOverlay(): OverlayController {
        return overlay ?: OverlayController(this).also { overlay = it }
    }

    /** Manual trigger from QS tile / notification action. */
    fun popOverlay() {
        ensureOverlay().startManualDictation()
    }

    /** Called by AccessibilityService when an editable text field is focused. */
    fun onEditableFocusDetected() {
        ensureOverlay().showBubble()
    }

    /** Called by AccessibilityService after the bubble-hide debounce. */
    fun onEditableFocusLost() {
        overlay?.hideBubble()
    }

    fun hideOverlay() {
        overlay?.teardown()
        overlay = null
    }

    /** Called by OverlayController when its lifecycle ends naturally. */
    fun onOverlayClosed() {
        overlay = null
    }

    // ─── Notification ──────────────────────────────────────────────────────

    private fun ensureNotificationChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = getString(R.string.notification_channel_desc)
                setShowBadge(false)
            }
            nm.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(): Notification {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }

        val dictateIntent = Intent(this, WisprService::class.java).apply {
            action = ACTION_DICTATE
        }
        val dictatePending = PendingIntent.getService(
            this, 1, dictateIntent, flags
        )

        val openIntent = Intent(this, MainActivity::class.java)
        val openPending = PendingIntent.getActivity(
            this, 2, openIntent, flags
        )

        val stopIntent = Intent(this, WisprService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPending = PendingIntent.getService(
            this, 3, stopIntent, flags
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_status)
            .setContentTitle("А-ГОЛОС активен")
            .setContentText("Тапните «Диктовка» или используйте плитку быстрых настроек")
            .setOngoing(true)
            .setContentIntent(openPending)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, "Диктовка", dictatePending)
            .addAction(0, "Стоп", stopPending)
            .build()
    }

    companion object {
        private const val TAG = "WisprService"
        const val CHANNEL_ID = "agolos-running"
        const val NOTIF_ID = 1001

        const val ACTION_DICTATE = "app.agolos.action.DICTATE"
        const val ACTION_STOP = "app.agolos.action.STOP"

        @Volatile
        var instance: WisprService? = null
            private set

        /** Convenience: start the service and request a dictation. */
        fun startDictation(ctx: Context) {
            val intent = Intent(ctx, WisprService::class.java).apply {
                action = ACTION_DICTATE
            }
            ctx.startForegroundService(intent)
        }

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, WisprService::class.java))
        }

        fun stop(ctx: Context) {
            val intent = Intent(ctx, WisprService::class.java).apply {
                action = ACTION_STOP
            }
            ctx.startService(intent)
        }
    }
}
