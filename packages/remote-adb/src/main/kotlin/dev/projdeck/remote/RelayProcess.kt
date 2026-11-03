package dev.projdeck.remote

import android.content.Context
import java.net.InetSocketAddress
import java.net.Socket

/**
 * App 这一侧管理独立转发进程（[RelayMain]）：查状态、让它退出、通过 adb 启动它。
 * 独立进程不属于 App，系统清理 App 时它不受影响；App 只负责在它不在时把它拉起来。
 */
object RelayProcess {
    data class Info(val version: String, val state: String, val error: String?)

    /** 向状态口发一行命令，读回一行。没有独立进程在运行时返回 null。 */
    private fun ask(cmd: String): Info? = try {
        Socket().use { s ->
            s.connect(InetSocketAddress("127.0.0.1", RelayMain.PORT), 300)
            s.soTimeout = 1_000
            s.getOutputStream().write("$cmd\n".toByteArray())
            s.getOutputStream().flush()
            val parts = s.getInputStream().bufferedReader().readLine()?.split('\t')
            if (parts == null || parts.size < 3 || parts[0] != "projdeck-relay") null else Info(parts[1], parts[2], parts.getOrNull(3)?.ifEmpty { null })
        }
    } catch (_: Exception) {
        null
    }

    fun query(): Info? = ask("status")

    fun quit() {
        ask("quit")
    }

    /** 这个 App 版本对应的版本标记；独立进程的版本和它不一致说明是更新前的旧代码，需要重启。 */
    fun version(c: Context): String {
        val info = c.packageManager.getPackageInfo(c.packageName, 0)
        @Suppress("DEPRECATION")
        return "${info.versionName}+${if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()}"
    }

    private fun quote(s: String) = "'" + s.replace("'", "'\\''") + "'"

    private const val LOG = "/data/local/tmp/projdeck-relay.log"

    /**
     * 启动独立进程的 shell 命令。照黑阈的做法分两层：外面一个 setsid 脱离会话的 sh 循环负责「死了就拉起来」，
     * 里面才是 app_process 起的 [RelayMain]；它正常退出（exit 0：收到 quit、或已有另一个在运行）循环就结束，
     * 其他退出（崩溃、被杀）3 秒后重启。输出写到 /data/local/tmp（shell 才有权限写，电脑上排查用），超过 500KB 清空。
     * 命令里不要放中文（libadb 按字符数而不是字节数算长度，会被截断）。结尾的 sleep 1 不能省：shell 退得太快的话，后台进程来不及脱离（实测）。
     */
    fun command(c: Context, base: String, key: String): String {
        val inner = "while :; do " +
            "[ \"\$(stat -c %s $LOG 2>/dev/null || echo 0)\" -gt 500000 ] && : > $LOG; " +
            "CLASSPATH=${quote(c.applicationInfo.sourceDir)} PROJDECK_BASE=${quote(base)} PROJDECK_KEY=${quote(key)} " +
            "PROJDECK_ID=${quote(Prefs.deviceId(c))} PROJDECK_VERSION=${quote(version(c))} " +
            "app_process /system/bin --nice-name=projdeck_relay dev.projdeck.app.RelayMain; rc=\$?; " +
            "echo \"\$(date '+%m-%d %H:%M:%S') relay exited rc=\$rc\"; [ \$rc -eq 0 ] && exit 0; sleep 3; done"
        return "setsid nohup sh -c ${quote(inner)} </dev/null >>$LOG 2>&1 & sleep 1; echo launched-by-\$(id -un) pid=\$!"
    }
}
