package dev.projdeck.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 后台通知：与电脑上的 projdeck 保持一条 Server-Sent Events 连接（/api/notify/stream），
 * Claude / Codex 完成或需要处理时显示系统通知，点通知打开对应的会话。
 * 不经过谷歌的推送服务，国内网络也能收到。安卓要求后台常驻的连接显示一条常驻通知。
 */
class NotifyService : Service() {
    @Volatile private var running = false
    @Volatile private var current: HttpURLConnection? = null
    private var worker: Thread? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_STATUS, "后台连接", NotificationManager.IMPORTANCE_MIN).apply {
                description = "保持与电脑的连接，用来接收通知（可以在系统设置里把这一类隐藏）"
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ALERTS, "完成和需处理", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Claude / Codex 完成了，或者在等你确认"
            },
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val ongoing = Notification.Builder(this, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("projdeck 正在接收通知")
            .setContentIntent(openApp(null, 0))
            .setOngoing(true)
            .build()
        startForeground(ID_STATUS, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        if (!running) {
            running = true
            worker = Thread(::loop, "projdeck-notify").also { it.start() }
        }
        return START_STICKY
    }

    /** 断线后重连，间隔从 2 秒逐步加到 1 分钟；连上后复位。 */
    private fun loop() {
        var backoff = 2_000L
        while (running) {
            try {
                listen()
                backoff = 2_000L
            } catch (_: Exception) {
                // 网络切换、电脑休眠等，稍后重连
            }
            if (!running) break
            try {
                Thread.sleep(backoff)
            } catch (_: InterruptedException) {
                break
            }
            backoff = (backoff * 2).coerceAtMost(60_000L)
        }
    }

    private fun listen() {
        val base = Prefs.base(this) ?: throw IllegalStateException("没有连接信息")
        val conn = URL("$base/api/notify/stream").openConnection() as HttpURLConnection
        current = conn
        conn.setRequestProperty("Cookie", "projdeck_key=${Prefs.key(this)}")
        conn.setRequestProperty("Accept", "text/event-stream")
        conn.connectTimeout = 15_000
        // 服务器每 25 秒发一次心跳，超过 70 秒没有任何数据就认为断了
        conn.readTimeout = 70_000
        try {
            if (conn.responseCode != 200) throw IllegalStateException("HTTP ${conn.responseCode}")
            conn.inputStream.bufferedReader(Charsets.UTF_8).use { r ->
                while (running) {
                    val line = r.readLine() ?: break
                    if (line.startsWith("data: ")) show(JSONObject(line.substring(6)))
                }
            }
        } finally {
            conn.disconnect()
            current = null
        }
    }

    private fun show(p: JSONObject) {
        val tag = p.optString("tag", "projdeck")
        val body = p.optString("body", "")
        val n = Notification.Builder(this, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(p.optString("title", "projdeck"))
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(openApp(p.optString("url", "/#/"), tag.hashCode()))
            .setAutoCancel(true)
            .build()
        // 同一个会话的新通知替换旧的
        getSystemService(NotificationManager::class.java).notify(tag, 2, n)
    }

    private fun openApp(path: String?, requestCode: Int): PendingIntent {
        val i = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (path != null) i.putExtra(EXTRA_PATH, path)
        return PendingIntent.getActivity(this, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    override fun onDestroy() {
        running = false
        current?.let { c -> Thread { c.disconnect() }.start() }
        worker?.interrupt()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val EXTRA_PATH = "dev.projdeck.app.PATH"
        private const val CHANNEL_STATUS = "status"
        private const val CHANNEL_ALERTS = "alerts"
        private const val ID_STATUS = 1

        fun start(c: Context) {
            c.startForegroundService(Intent(c, NotifyService::class.java))
        }

        fun stop(c: Context) {
            c.stopService(Intent(c, NotifyService::class.java))
        }
    }
}
