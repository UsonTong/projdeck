package dev.projdeck.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * 远程调试的转发：保持一条到 projdeck 服务器的 WebSocket（/ws/adb），电脑上的 adb 通过它连到手机本机的 adbd（5555 端口）。
 * 同时负责「自动恢复」：手机重启后 TCP 模式会消失，这里发现了就用 App 自己的授权重新打开。
 *
 * WebSocket 上的帧格式见服务器的 adbRelay.ts：[类型 1 字节][连接号 4 字节大端][数据]，OPEN=1、DATA=2、CLOSE=3。
 */
class AdbRelayService : Service() {
    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    @Volatile private var running = false
    @Volatile private var ws: WebSocket? = null
    private val conns = ConcurrentHashMap<Int, Conn>()
    private var linkThread: Thread? = null
    private var recoveryThread: Thread? = null
    private var reportThread: Thread? = null

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL, "远程调试", NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) })
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        startForeground(
            ID,
            Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_notification).setContentTitle("远程调试已开启")
                .setContentText("公司电脑可以通过 projdeck 连接这台手机的 adb").setContentIntent(open).setOngoing(true).build(),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING,
        )
        if (!running) {
            running = true
            state = "connecting"
            linkThread = thread(name = "projdeck-adb-link") { linkLoop() }
            recoveryThread = thread(name = "projdeck-adb-recovery") { recoveryLoop() }
            reportThread = thread(name = "projdeck-adb-report") { reportLoop() }
        }
        return START_STICKY
    }

    // ---- 与服务器的连接 ----

    private fun linkLoop() {
        var backoff = 2_000L
        while (running) {
            val base = Prefs.base(this)
            val key = Prefs.key(this)
            if (base == null || key == null) {
                Thread.sleep(5_000)
                continue
            }
            val closed = CountDownLatch(1)
            val request = Request.Builder().url(base.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + "/ws/adb")
                .header("Cookie", "projdeck_key=$key").build()
            val socket = client.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    Log.i(TAG, "已连上服务器")
                    state = "connected"
                    backoff = 2_000L
                    sendReport(webSocket)
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) = onFrame(webSocket, bytes)

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    closed.countDown()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    Log.w(TAG, "服务器连接断开：${t.javaClass.simpleName}: ${t.message} ${response?.code ?: ""}")
                    closed.countDown()
                }
            })
            ws = socket
            try {
                while (running && !closed.await(1, TimeUnit.SECONDS)) { /* 等它断开 */ }
            } catch (_: InterruptedException) {
                break
            }
            socket.cancel()
            ws = null
            closeAll()
            if (!running) break
            state = "connecting"
            try {
                Thread.sleep(backoff)
            } catch (_: InterruptedException) {
                break
            }
            backoff = (backoff * 2).coerceAtMost(30_000L)
        }
    }

    private fun onFrame(webSocket: WebSocket, bytes: ByteString) {
        if (bytes.size < 5) return
        val type = bytes[0].toInt()
        val id = ((bytes[1].toInt() and 0xff) shl 24) or ((bytes[2].toInt() and 0xff) shl 16) or ((bytes[3].toInt() and 0xff) shl 8) or (bytes[4].toInt() and 0xff)
        when (type) {
            OPEN -> conns.put(id, Conn(id, webSocket).also { it.start() })?.close()
            DATA -> conns[id]?.queue?.put(bytes.substring(5).toByteArray())
            CLOSE -> conns.remove(id)?.close()
        }
    }

    private fun closeAll() {
        for (c in conns.values) c.close()
        conns.clear()
    }

    /** 电脑上的一个 adb 连接：手机这边连一个到本机 adbd 的 socket，两头互相转发。 */
    private inner class Conn(val id: Int, val link: WebSocket) {
        val queue = LinkedBlockingQueue<ByteArray>()
        @Volatile private var socket: Socket? = null
        @Volatile private var closed = false

        fun start() {
            thread(name = "projdeck-adb-conn-$id") {
                try {
                    val s = Socket().also { it.tcpNoDelay = true }
                    s.connect(InetSocketAddress("127.0.0.1", RemoteAdb.TCP_PORT), 3_000)
                    socket = s
                    thread(name = "projdeck-adb-read-$id") { readLoop(s) }
                    val out = s.getOutputStream()
                    while (!closed) {
                        val chunk = queue.poll(1, TimeUnit.SECONDS) ?: continue
                        if (chunk.isEmpty()) break
                        out.write(chunk)
                        out.flush()
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "连接 $id：${e.javaClass.simpleName}: ${e.message}")
                } finally {
                    close()
                }
            }
        }

        private fun readLoop(s: Socket) {
            val buf = ByteArray(16 * 1024)
            try {
                val input = s.getInputStream()
                while (!closed) {
                    val n = input.read(buf)
                    if (n < 0) break
                    // 服务器那一头跟不上时先别读，免得手机上越积越多
                    while (!closed && link.queueSize() > 4L * 1024 * 1024) Thread.sleep(50)
                    link.send(frame(DATA, id, buf, n))
                }
            } catch (_: Exception) {
                // 对方关闭
            } finally {
                close()
            }
        }

        fun close() {
            if (closed) return
            closed = true
            queue.offer(ByteArray(0))
            runCatching { socket?.close() }
            if (conns.remove(id, this)) link.send(frame(CLOSE, id, ByteArray(0), 0))
        }
    }

    private fun frame(type: Int, id: Int, data: ByteArray, len: Int): ByteString {
        val out = ByteArray(5 + len)
        out[0] = type.toByte()
        out[1] = (id ushr 24).toByte()
        out[2] = (id ushr 16).toByte()
        out[3] = (id ushr 8).toByte()
        out[4] = id.toByte()
        System.arraycopy(data, 0, out, 5, len)
        return out.toByteString()
    }

    // ---- 向服务器介绍自己（「设备」页显示的内容） ----

    /** 连上后马上发一次，之后每 30 秒一次。服务器只当文本消息处理，不影响 adb 的数据帧。 */
    private fun reportLoop() {
        while (running) {
            try {
                Thread.sleep(30_000)
            } catch (_: InterruptedException) {
                break
            }
            ws?.let { sendReport(it) }
        }
    }

    private fun sendReport(socket: WebSocket) {
        try {
            val battery = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
            val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val cm = getSystemService(ConnectivityManager::class.java)
            @Suppress("DEPRECATION")
            val caps = cm.allNetworks.mapNotNull { cm.getNetworkCapabilities(it) }
            val real = caps.filter { !it.hasTransport(NetworkCapabilities.TRANSPORT_VPN) }
            val network = when {
                real.any { it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) } -> "wifi"
                real.any { it.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) } -> "mobile"
                else -> "none"
            }
            val json = JSONObject()
                .put("id", Prefs.deviceId(this))
                .put("model", Build.MODEL)
                .put("brand", Build.MANUFACTURER.replaceFirstChar { it.uppercase() })
                .put("os", "Android ${Build.VERSION.RELEASE}")
                .put("network", network)
                .put("vpn", caps.any { it.hasTransport(NetworkCapabilities.TRANSPORT_VPN) })
                .put("tcpMode", RemoteAdb.tcpReachable())
                .put("appVersion", packageManager.getPackageInfo(packageName, 0).versionName)
            if (level >= 0) json.put("battery", level * 100 / scale.coerceAtLeast(1))
            if (status >= 0) json.put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
            socket.send(json.toString())
        } catch (e: Exception) {
            Log.w(TAG, "发送设备信息失败：${e.javaClass.simpleName}: ${e.message}")
        }
    }

    // ---- 自动恢复 TCP 模式 ----

    /**
     * 手机有没有连着 Wi-Fi。不能只看默认网络：开着 FlClash 之类的 VPN 时，默认网络是 VPN 网络，不是 Wi-Fi，
     * 所以要看手机上所有的网络里有没有 Wi-Fi（VPN 自己不算）。
     */
    @Suppress("DEPRECATION")
    private fun onWifi(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java)
        return cm.allNetworks.any { n ->
            val caps = cm.getNetworkCapabilities(n)
            caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        }
    }

    /**
     * 手机重启后 adb 的 TCP 模式会消失。发现 5555 没在监听、又连着 Wi-Fi 时，用 App 自己的授权打开无线调试，
     * 连上它，发 tcpip 切回 TCP 模式（之后不需要 Wi-Fi）。失败时间隔逐步拉长，免得一直耗电。
     */
    private fun recoveryLoop() {
        var wait = 5_000L
        while (running) {
            try {
                Thread.sleep(wait)
            } catch (_: InterruptedException) {
                break
            }
            if (RemoteAdb.tcpReachable()) {
                wait = 10_000L
                continue
            }
            if (!RemoteAdb.paired(this)) {
                RemoteAdb.lastMessage = "还没有配对，无法自动打开 TCP 模式"
                wait = 30_000L
                continue
            }
            if (!onWifi()) {
                RemoteAdb.lastMessage = "TCP 模式没有开，等待连上 Wi-Fi 后自动打开"
                wait = 10_000L
                continue
            }
            Log.i(TAG, "TCP 模式不在了，自动恢复")
            val done = CountDownLatch(1)
            var ok = false
            RemoteAdb.async({ RemoteAdb.enableTcp(this) }) { r ->
                ok = r.isSuccess
                RemoteAdb.lastMessage = r.fold({ "$it（自动）" }, { "自动恢复 TCP 模式失败：${it.message}" })
                if (r.isFailure) Log.w(TAG, "自动恢复失败", r.exceptionOrNull())
                done.countDown()
            }
            done.await(120, TimeUnit.SECONDS)
            wait = if (ok) 10_000L else (wait * 2).coerceIn(30_000L, 300_000L)
        }
    }

    override fun onDestroy() {
        running = false
        state = "off"
        ws?.cancel()
        closeAll()
        linkThread?.interrupt()
        recoveryThread?.interrupt()
        reportThread?.interrupt()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "ProjdeckAdb"
        private const val CHANNEL = "adb_relay"
        private const val ID = 4
        private const val OPEN = 1
        private const val DATA = 2
        private const val CLOSE = 3

        /** off / connecting / connected */
        @Volatile var state = "off"

        fun start(c: Context) {
            c.startForegroundService(Intent(c, AdbRelayService::class.java))
        }

        fun stop(c: Context) {
            c.stopService(Intent(c, AdbRelayService::class.java))
        }
    }
}
