package dev.projdeck.remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

/**
 * 配对服务：保持 App 在后台活着，等待配对助手（无障碍服务）读到系统的配对码窗口并完成配对，
 * 然后用通知告诉用户结果。系统的配对码窗口一离开前台，配对服务就会停止，所以全程不需要用户输入配对码。
 */
class AdbPairingService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private val timeout = Runnable { finish("配对超时了，请重新开始") }

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_FG, "远程调试（后台）", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "远程调试配对", NotificationManager.IMPORTANCE_DEFAULT).apply { setShowBadge(false) })
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(
            ID,
            Notification.Builder(this, CHANNEL_FG).setSmallIcon(R.drawable.ic_notification).setContentTitle("正在配对远程调试")
                .setContentText("请在系统的「无线调试」里点「使用配对码配对」，配对助手会自动读取配对码").setOngoing(true).build(),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING,
        )
        Log.i(TAG, "配对服务启动，等待配对窗口 accessibility=${RemoteAdb.accessibilityOn(this)}")
        RemoteAdb.lastMessage = "等待配对码窗口…"
        PairingState.onResult = { msg -> main.post { finish(msg) } }
        PairingState.waiting = true
        main.removeCallbacks(timeout)
        main.postDelayed(timeout, 5 * 60_000L)
        return START_NOT_STICKY
    }

    private fun finish(message: String) {
        PairingState.waiting = false
        PairingState.onResult = null
        RemoteAdb.lastMessage = message
        stopForeground(STOP_FOREGROUND_REMOVE)
        getSystemService(NotificationManager::class.java).notify(
            ID + 1,
            Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_notification).setContentTitle("远程调试").setContentText(message).setAutoCancel(true).build(),
        )
        stopSelf()
    }

    override fun onDestroy() {
        main.removeCallbacks(timeout)
        PairingState.waiting = false
        PairingState.onResult = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "ProjdeckAdb"
        private const val CHANNEL = "adb_pairing"
        private const val CHANNEL_FG = "adb_pairing_fg"
        private const val ID = 3

        fun start(c: Context) {
            c.startForegroundService(Intent(c, AdbPairingService::class.java))
        }
    }
}
