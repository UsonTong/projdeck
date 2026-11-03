package dev.projdeck.remote

import android.os.Build
import org.json.JSONObject
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import kotlin.system.exitProcess

/**
 * 远程 adb 的独立转发进程。像 Shizuku 那样，由 adb（shell 身份）用 app_process 启动，不属于 App 进程：
 *   CLASSPATH=<apk> app_process /system/bin --nice-name=projdeck_relay dev.projdeck.app.RelayMain
 * 所以小米「划掉后台」清理 App、App 被强行停止，都不会影响它；只有手机重启时才会消失（之后 App 会再启动它）。
 *
 * 配置走环境变量（别的 App 看不到）：PROJDECK_BASE、PROJDECK_KEY、PROJDECK_ID、PROJDECK_VERSION。
 * 本机 127.0.0.1:[PORT] 上有个很小的状态口：App 连上来发 "status" 得到当前状态，发 "quit" 让它退出（升级时用）。
 */
object RelayMain {
    const val PORT = 15556

    @Volatile private var state = "connecting"
    @Volatile private var error: String? = null

    @JvmStatic
    fun main(args: Array<String>) {
        val base = System.getenv("PROJDECK_BASE")
        val key = System.getenv("PROJDECK_KEY")
        val id = System.getenv("PROJDECK_ID")
        val version = System.getenv("PROJDECK_VERSION") ?: "?"
        if (base == null || key == null || id == null) {
            println("缺少 PROJDECK_BASE / PROJDECK_KEY / PROJDECK_ID")
            exitProcess(0) // 配置不对，重启也没用，别让外层循环空转
        }
        // 同一时间只留一个：状态口被占用说明已经有一个在跑
        val server = try {
            ServerSocket().apply {
                reuseAddress = true
                bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 8)
            }
        } catch (e: Exception) {
            println("已经有一个在运行：${e.message}")
            exitProcess(0)
        }
        val core = RelayCore(
            base, key, RemoteAdb.TCP_PORT,
            log = ::log,
            report = { report(id, version) },
            onState = { s, e -> state = s; error = e },
        )
        core.start()
        println("独立转发进程已启动 version=$version pid=${android.os.Process.myPid()}")
        while (true) {
            val client = try {
                server.accept()
            } catch (_: Exception) {
                continue
            }
            try {
                client.soTimeout = 1_000
                val line = runCatching { client.getInputStream().bufferedReader().readLine() }.getOrNull() ?: "status"
                client.getOutputStream().write("projdeck-relay\t$version\t$state\t${error ?: ""}\n".toByteArray())
                client.getOutputStream().flush()
                client.close()
                if (line.trim() == "quit") {
                    println("收到 quit，退出")
                    core.stop()
                    exitProcess(0)
                }
            } catch (_: Exception) {
                runCatching { client.close() }
            }
        }
    }

    private var lines = 0

    /** 输出到日志文件；一次运行最多 400 行，免得服务器一直连不上时把文件写满。 */
    private fun log(msg: String) {
        if (++lines > 400) return
        println("${java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.US).format(java.util.Date())} $msg")
        if (lines == 400) println("（日志已满 400 行，之后不再记录）")
    }

    /** 电量：shell 读不了 sysfs（SELinux 不允许），改用 dumpsys battery。 */
    private fun battery(json: JSONObject) {
        try {
            val out = ProcessBuilder("dumpsys", "battery").redirectErrorStream(true).start().inputStream.bufferedReader().readText()
            Regex("level: (\\d+)").find(out)?.let { json.put("battery", it.groupValues[1].toInt()) }
            Regex("status: (\\d+)").find(out)?.let { json.put("charging", it.groupValues[1] == "2" || it.groupValues[1] == "5") }
        } catch (_: Exception) {
            // 拿不到就不报电量
        }
    }

    /** 没有 Context 时能拿到的设备信息：型号来自 Build，电量用 dumpsys，网络看网卡。 */
    private fun report(id: String, version: String): JSONObject {
        val json = JSONObject()
            .put("id", id)
            .put("model", Build.MODEL)
            .put("brand", Build.MANUFACTURER.replaceFirstChar { it.uppercase() })
            .put("os", "Android ${Build.VERSION.RELEASE}")
            .put("appVersion", version.substringBefore('+'))
        val up = try {
            NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback && it.interfaceAddresses.isNotEmpty() }.map { it.name }
        } catch (_: Exception) {
            emptyList()
        }
        json.put("network", if (up.any { it.startsWith("wlan") }) "wifi" else if (up.any { it.startsWith("rmnet") || it.startsWith("ccmni") }) "mobile" else "none")
        json.put("vpn", up.any { it.startsWith("tun") || it.startsWith("ppp") })
        json.put("tcpMode", runCatching { Socket().use { it.connect(InetSocketAddress("127.0.0.1", RemoteAdb.TCP_PORT), 300) }; true }.getOrDefault(false))
        battery(json)
        return json
    }
}
