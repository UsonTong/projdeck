package dev.projdeck.remote

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 远程连接的事件记录（服务启动/被系统杀掉/连上/断开及原因），存在 App 私有目录的 relay.log 里，只保留最近一段。
 * 用来分辨「老掉线」到底是进程被系统杀了，还是网络断了。
 */
object RelayLog {
    private const val MAX = 64 * 1024

    @Synchronized
    fun add(c: Context, msg: String) {
        try {
            val f = File(c.filesDir, "relay.log")
            if (f.length() > MAX) f.writeText(f.readText().takeLast(MAX / 2).substringAfter('\n'))
            f.appendText("${SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(Date())} $msg\n")
        } catch (_: Exception) {
            // 记录失败不影响功能
        }
    }
}
