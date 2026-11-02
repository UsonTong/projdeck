package dev.projdeck.app

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
 * 远程 adb 的转发核心：保持一条到 projdeck 服务器的 WebSocket（/ws/adb），电脑上的 adb 经它连到手机本机的 adbd。
 * 不依赖 Android 的 Context，所以既能跑在 App 里（[AdbRelayService]，作为备用），
 * 也能跑在独立进程里（[RelayMain]，像 Shizuku 那样用 app_process 启动，App 被系统清理也不受影响）。
 *
 * WebSocket 上的帧格式见服务器的 adbRelay.ts：[类型 1 字节][连接号 4 字节大端][数据]，OPEN=1、DATA=2、CLOSE=3。
 * 文本消息是手机的自我介绍（JSON，见服务器的 DeviceReport）。
 */
class RelayCore(
    private val base: String,
    private val key: String,
    private val tcpPort: Int,
    private val log: (String) -> Unit,
    /** 设备自我介绍；每 30 秒和刚连上时发一次 */
    private val report: () -> JSONObject?,
    /** 状态变化：connecting / connected，以及最近一次连不上的原因 */
    private val onState: (state: String, error: String?) -> Unit,
) {
    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    @Volatile private var running = false
    @Volatile private var ws: WebSocket? = null
    private val conns = ConcurrentHashMap<Int, Conn>()
    private var linkThread: Thread? = null
    private var reportThread: Thread? = null

    fun start() {
        if (running) return
        running = true
        onState("connecting", null)
        linkThread = thread(name = "projdeck-relay-link") { linkLoop() }
        reportThread = thread(name = "projdeck-relay-report") { reportLoop() }
    }

    fun stop() {
        running = false
        ws?.cancel()
        closeAll()
        linkThread?.interrupt()
        reportThread?.interrupt()
    }

    private fun linkLoop() {
        var backoff = 2_000L
        while (running) {
            val closed = CountDownLatch(1)
            val request = Request.Builder().url(base.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + "/ws/adb")
                .header("Cookie", "projdeck_key=$key").build()
            val socket = client.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    log("已连上服务器")
                    onState("connected", null)
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
                    log("断开：${t.javaClass.simpleName}: ${t.message} ${response?.code ?: ""}")
                    onState("connecting", if (response?.code == 401) "服务器拒绝了访问密钥（401）" else "连不上服务器：${t.message ?: t.javaClass.simpleName}")
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
            onState("connecting", null)
            try {
                Thread.sleep(backoff)
            } catch (_: InterruptedException) {
                break
            }
            backoff = (backoff * 2).coerceAtMost(10_000L)
        }
    }

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
            report()?.let { socket.send(it.toString()) }
        } catch (e: Exception) {
            log("发送设备信息失败：${e.javaClass.simpleName}: ${e.message}")
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

    /** 电脑上的一个 adb 连接：这边连一个到本机 adbd 的 socket，两头互相转发。 */
    private inner class Conn(val id: Int, val link: WebSocket) {
        val queue = LinkedBlockingQueue<ByteArray>()
        @Volatile private var socket: Socket? = null
        @Volatile private var closed = false

        fun start() {
            thread(name = "projdeck-relay-conn-$id") {
                try {
                    val s = Socket().also { it.tcpNoDelay = true }
                    s.connect(InetSocketAddress("127.0.0.1", tcpPort), 3_000)
                    socket = s
                    thread(name = "projdeck-relay-read-$id") { readLoop(s) }
                    val out = s.getOutputStream()
                    while (!closed) {
                        val chunk = queue.poll(1, TimeUnit.SECONDS) ?: continue
                        if (chunk.isEmpty()) break
                        out.write(chunk)
                        out.flush()
                    }
                } catch (e: Exception) {
                    log("连接 $id：${e.javaClass.simpleName}: ${e.message}")
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
                    // 服务器那一头跟不上时先别读，免得这边越积越多
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

    private companion object {
        const val OPEN = 1
        const val DATA = 2
        const val CLOSE = 3
    }
}
