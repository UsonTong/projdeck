package dev.projdeck.app

import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 远程调试：用 App 里的 adb 客户端操作手机自己的 adbd。
 * 配对一次后，App 能自己给自己授权、打开无线调试、把 adb 切到 TCP 模式（5555）；
 * 之后电脑经转发通道连到 localhost:5555 就是连这台手机。
 */
object RemoteAdb {
    const val TCP_PORT = 5555
    private const val PERMISSION = "android.permission.WRITE_SECURE_SETTINGS"

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var manager: ProjdeckAdb? = null

    /** 最近一次操作的结果，界面上显示。 */
    @Volatile var lastMessage: String = ""

    private fun prefs(c: Context) = c.getSharedPreferences("remote_adb", Context.MODE_PRIVATE)

    private fun manager(c: Context): ProjdeckAdb =
        manager ?: synchronized(this) { manager ?: ProjdeckAdb(c.applicationContext).also { manager = it } }

    /** 在后台线程执行，结果回到主线程。操作一个接一个排队，避免同时操作同一个连接。 */
    fun <T> async(work: () -> T, done: (Result<T>) -> Unit) {
        io.execute {
            val r = runCatching(work)
            main.post { done(r) }
        }
    }

    fun paired(c: Context) = prefs(c).getBoolean("paired", false)

    /** 配对助手（无障碍服务）是否已被用户打开。 */
    fun accessibilityOn(c: Context): Boolean {
        val enabled = Settings.Secure.getString(c.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val name = "${c.packageName}/${c.packageName}.PairingAccessibilityService"
        return enabled.split(':').any { it.equals(name, ignoreCase = true) || it.equals("${c.packageName}/.PairingAccessibilityService", ignoreCase = true) }
    }

    fun hasSecure(c: Context) = c.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED

    fun wirelessOn(c: Context) = Settings.Global.getInt(c.contentResolver, "adb_wifi_enabled", 0) == 1

    /** adb 的 TCP 模式是否已经在手机本机的 5555 端口监听。 */
    fun tcpReachable(): Boolean = try {
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", TCP_PORT), 500) }
        true
    } catch (_: Exception) {
        false
    }

    fun status(c: Context): Map<String, Any> = mapOf(
        "paired" to paired(c),
        "secureGranted" to hasSecure(c),
        "wirelessOn" to wirelessOn(c),
        "tcp" to tcpReachable(),
        "accessibility" to accessibilityOn(c),
        "relayEnabled" to Prefs.relayEnabled(c),
        "relay" to AdbRelayService.state,
        "message" to lastMessage,
    )

    /** 无线调试配对（配对码在手机的「无线调试 → 使用配对码配对」里）。 */
    fun pair(c: Context, host: String, port: Int, code: String) {
        Log.i("ProjdeckAdb", "pair $host:$port")
        val m = manager(c)
        Log.i("ProjdeckAdb", "密钥已就绪，开始 TLS 配对")
        m.pair(host, port, code)
        prefs(c).edit().putBoolean("paired", true).apply()
    }

    /** 本机在 32768 以上的动态端口里监听的端口（无线调试的 TLS 端口每次都不一样，在这个范围里）。 */
    private fun listeningPorts(): List<Int> {
        val found = java.util.concurrent.ConcurrentLinkedQueue<Int>()
        val pool = Executors.newFixedThreadPool(128)
        for (port in 32768..60999) {
            pool.execute {
                try {
                    Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 400) }
                    found.add(port)
                } catch (_: Exception) {
                    // 没有监听
                }
            }
        }
        pool.shutdown()
        pool.awaitTermination(60, TimeUnit.SECONDS)
        return found.sorted().filter { it != TCP_PORT }
    }

    /**
     * 连上本机的无线调试（TLS）。先用 mDNS 发现端口；有的系统（如 MIUI）发现不了，
     * 就扫描本机监听的端口，逐个试着连，连上的那个就是 adbd 的 TLS 端口。
     */
    private fun connectTls(c: Context): ProjdeckAdb {
        val m = manager(c)
        if (m.isConnected) m.disconnect()
        // 上次连上的端口（无线调试没关过的话端口不变），先试它，免得每次都等 mDNS 超时再扫描
        val cached = prefs(c).getInt("tls_port", 0)
        if (cached > 0) {
            m.setTimeout(3, TimeUnit.SECONDS)
            try {
                if (m.connect("127.0.0.1", cached)) {
                    Log.i("ProjdeckAdb", "已用上次的端口连上无线调试 port=$cached")
                    return m
                }
            } catch (e: Exception) {
                Log.i("ProjdeckAdb", "上次的端口 $cached 不能用了：${e.javaClass.simpleName}")
                runCatching { m.disconnect() }
            }
        }
        val viaMdns = try {
            m.connectTls(c, 5_000)
        } catch (e: Exception) {
            Log.w("ProjdeckAdb", "mDNS 连接失败：${e.javaClass.simpleName}: ${e.message}")
            false
        }
        if (viaMdns) {
            Log.i("ProjdeckAdb", "已通过 mDNS 连上无线调试")
            return m
        }
        val ports = listeningPorts()
        Log.i("ProjdeckAdb", "mDNS 没连上，扫描到本机监听端口：$ports")
        m.setTimeout(4, TimeUnit.SECONDS)
        for (port in ports) {
            try {
                if (m.connect("127.0.0.1", port)) {
                    Log.i("ProjdeckAdb", "已通过端口扫描连上无线调试 port=$port")
                    prefs(c).edit().putInt("tls_port", port).apply()
                    return m
                }
            } catch (e: Exception) {
                Log.i("ProjdeckAdb", "端口 $port 不是无线调试：${e.javaClass.simpleName}: ${e.message}")
                runCatching { m.disconnect() }
            }
        }
        throw IllegalStateException("连不上无线调试：请确认手机连着 Wi-Fi，并且打开了「无线调试」（扫描到的端口：${ports.joinToString()}）")
    }

    /** 通过 adb 执行一个服务（shell 命令、tcpip），返回输出；连接被对方断开（adbd 重启）时返回已读到的部分。 */
    private fun runService(m: ProjdeckAdb, service: String): String {
        val out = StringBuilder()
        try {
            m.openStream(service).use { s ->
                val buf = ByteArray(4096)
                val input = s.openInputStream()
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.append(String(buf, 0, n))
                }
            }
        } catch (_: Exception) {
            // adbd 重启（tcpip）时连接会断开
        }
        return out.toString().trim()
    }

    /** 无线调试开着、已配对时：让 App 自己拥有 WRITE_SECURE_SETTINGS（之后能自己开关无线调试，重启后自动恢复）。 */
    fun grantSelf(c: Context): String {
        if (hasSecure(c)) return "已经有授权"
        val m = connectTls(c)
        try {
            val out = runService(m, "shell:pm grant ${c.packageName} $PERMISSION")
            Log.i("ProjdeckAdb", "pm grant 输出：'$out' secure=${hasSecure(c)}")
            if (!hasSecure(c)) throw IllegalStateException("授权没有成功：$out")
        } finally {
            runCatching { m.disconnect() }
        }
        return "已授权"
    }

    private fun setWireless(c: Context, on: Boolean) {
        val cr = c.contentResolver
        if (on && Settings.Global.getInt(cr, Settings.Global.ADB_ENABLED, 0) != 1) Settings.Global.putInt(cr, Settings.Global.ADB_ENABLED, 1)
        Settings.Global.putInt(cr, "adb_wifi_enabled", if (on) 1 else 0)
    }

    /** 把 adb 切到 TCP 模式：之后不需要 Wi-Fi，电脑通过转发通道连本机 5555 就是连这台手机。 */
    fun enableTcp(c: Context): String {
        if (tcpReachable()) return "已经是 TCP 模式（$TCP_PORT）"
        if (!paired(c)) throw IllegalStateException("还没有配对")
        val turnedOn = !wirelessOn(c)
        if (turnedOn) {
            if (!hasSecure(c)) throw IllegalStateException("请先打开手机的「无线调试」，或完成授权")
            setWireless(c, true)
            Thread.sleep(1500)
            // 这个 Wi-Fi 还没被允许时，系统会立刻把它关掉并弹出确认框
            if (!wirelessOn(c)) throw IllegalStateException("系统没有打开无线调试：请在手机上的弹框里选「始终允许」，然后再试")
        }
        val m = connectTls(c)
        val reply = try {
            runService(m, "tcpip:$TCP_PORT")
        } finally {
            runCatching { m.disconnect() }
        }
        val deadline = System.currentTimeMillis() + 10_000
        while (!tcpReachable()) {
            if (System.currentTimeMillis() > deadline) throw IllegalStateException("没有切到 TCP 模式：$reply")
            Thread.sleep(300)
        }
        // 无线调试只是切换时需要，之后关掉，减少暴露
        if (turnedOn && hasSecure(c)) setWireless(c, false)
        return "已切到 TCP 模式（$TCP_PORT）"
    }

    fun close() {
        runCatching { manager?.close() }
        manager = null
        io.shutdown()
        io.awaitTermination(1, TimeUnit.SECONDS)
    }
}
