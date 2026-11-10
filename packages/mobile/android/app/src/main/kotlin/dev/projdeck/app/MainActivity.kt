package dev.projdeck.app

import dev.projdeck.remote.AdbPairingService
import dev.projdeck.remote.AdbRelayService
import dev.projdeck.remote.Prefs
import dev.projdeck.remote.RelayLog
import dev.projdeck.remote.RemoteAdb

import android.Manifest
import android.app.DownloadManager
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.core.content.FileProvider
import android.content.pm.PackageManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Flutter 的宿主。通过 projdeck/native 通道给 Dart 提供：后台通知的开关（需要通知权限）、
 * 以及点通知打开 App 时要去的页面。
 */
class MainActivity : FlutterActivity() {
    private var channel: MethodChannel? = null
    private var pendingPermission: MethodChannel.Result? = null
    private var pendingConfig: Pair<String, String>? = null
    private var harnessViews: HarnessWebViewFactory? = null
    private var terminalViews: TerminalWebViewFactory? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val views = HarnessWebViewFactory(this)
        harnessViews = views
        flutterEngine.platformViewsController.registry.registerViewFactory("projdeck/harness", views)
        val terminals = TerminalWebViewFactory(this)
        terminalViews = terminals
        flutterEngine.platformViewsController.registry.registerViewFactory("projdeck/terminal", terminals)
        val ch = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "projdeck/native")
        channel = ch
        ch.setMethodCallHandler { call, result ->
            when (call.method) {
                "openHarnessWeb" -> HarnessWebActivity.open(
                    this, call.argument<String>("base"), call.argument<String>("key"), call.argument<Boolean>("full") == true,
                ) { ok ->
                    if (ok) result.success(null)
                    else result.error("harness", "无法打开 Harness，请检查连接地址与系统 WebView", null)
                }
                "notificationsEnabled" -> result.success(Prefs.notificationsEnabled(this))
                "setNotifications" -> {
                    val on = call.argument<Boolean>("on") == true
                    if (!on) {
                        Prefs.setNotifications(this, false)
                        NotifyService.stop(this)
                        result.success(true)
                    } else {
                        val config = Pair(call.argument<String>("base")!!, call.argument<String>("key")!!)
                        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
                            enable(config)
                            result.success(true)
                        } else {
                            pendingPermission = result
                            pendingConfig = config
                            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
                        }
                    }
                }
                // 用 adb 安装后直接登录：am start … --es link https://…/k/…
                "initialLink" -> result.success(intent?.getStringExtra("link").also { intent?.removeExtra("link") })
                "initialPath" -> result.success(intent?.getStringExtra(NotifyService.EXTRA_PATH).also { intent?.removeExtra(NotifyService.EXTRA_PATH) })
                "clipboardFile" -> result.success(clipboardFile())
                // ---- 远程调试 ----
                // 状态不能和配对、切 TCP、启动独立进程这些耗时的 adb 操作排同一个队，否则它们执行的那几秒页面拿不到状态，
                // 三个步骤会全显示成「没完成」
                "appVersion" -> {
                    val info = packageManager.getPackageInfo(packageName, 0)
                    @Suppress("DEPRECATION")
                    val code = if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
                    result.success(mapOf("name" to info.versionName, "code" to code))
                }
                "adbStatus" -> Thread {
                    val r = runCatching { RemoteAdb.status(this) }
                    runOnUiThread { r.fold({ result.success(it) }, { result.error("adb", it.message, null) }) }
                }.start()
                "adbStartPairing" -> {
                    AdbPairingService.start(this)
                    result.success(true)
                }
                "adbRelaySet" -> {
                    val on = call.argument<Boolean>("on") == true
                    if (on) {
                        Prefs.setConnection(this, call.argument<String>("base")!!, call.argument<String>("key")!!)
                        Prefs.setRelay(this, true)
                        AdbRelayService.start(this)
                    } else {
                        Prefs.setRelay(this, false)
                        AdbRelayService.stop(this)
                    }
                    result.success(true)
                }
                "openAutostartSettings" -> result.success(openAutostartSettings())
                "requestUnrestrictedBattery" -> {
                    try {
                        startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
                    } catch (_: Exception) {
                        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                    }
                    result.success(true)
                }
                "openDeveloperSettings" -> result.success(openDeveloperSettings())
                "openAccessibilitySettings" -> {
                    startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    result.success(true)
                }
                "adbGrantSelf" -> RemoteAdb.async({ RemoteAdb.grantSelf(this) }) { r -> reply(result, r) }
                "adbEnableTcp" -> RemoteAdb.async({ RemoteAdb.enableTcp(this) }) { r -> reply(result, r) }
                "downloadAndInstall" -> {
                    val url = call.argument<String>("url")
                    if (url == null) {
                        result.error("update", "缺少更新地址", null)
                    } else {
                        val cookie = call.argument<String>("cookie") ?: ""
                        result.success(true)
                        Thread { downloadUpdate(url, cookie) }.start()
                    }
                }
                "download" -> {
                    val req = DownloadManager.Request(Uri.parse(call.argument<String>("url")))
                        .addRequestHeader("Cookie", call.argument<String>("cookie"))
                        .setTitle(call.argument<String>("name"))
                        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, call.argument<String>("name"))
                    (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
                    result.success(true)
                }
                else -> result.notImplemented()
            }
        }
    }

    /**
     * 回到前台时确保后台连接在跑（例如被系统清理后重新打开 App、更新 App 后）。
     * 必须在 onResume 里做：进程刚启动、界面还没出来时系统把 App 当成后台，会拒绝启动前台服务
     * （日志里是 "Background start not allowed"），这就是更新后转发一直起不来的原因。
     */
    override fun onResume() {
        super.onResume()
        try {
            if (Prefs.notificationsEnabled(this)) NotifyService.start(this)
            if (Prefs.relayEnabled(this)) AdbRelayService.start(this)
        } catch (e: Exception) {
            RelayLog.add(this, "打开 App 时启动后台服务失败：${e.javaClass.simpleName}: ${e.message}")
        }
    }

    /**
     * 打开「自启动管理」：手机重启、App 更新后，系统默认不让没授权的 App 自己启动，远程连接就恢复不了。
     * 小米、OPPO / realme 各有各的入口；都打不开就打开这个 App 的系统详情页。
     */
    private fun openAutostartSettings(): Boolean {
        val candidates = listOf(
            Intent().setClassName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
            Intent().setClassName("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
            Intent().setClassName("com.oplus.battery", "com.oplus.startupapp.view.StartupAppListActivity"),
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")),
        )
        for (intent in candidates) {
            try {
                startActivity(intent)
                return true
            } catch (_: Exception) {
                // 换下一个
            }
        }
        return false
    }

    /** 打开系统的开发者选项，并定位到「无线调试」；打不开时返回 false。 */
    private fun openDeveloperSettings(): Boolean {
        val withTarget = Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS).apply {
            putExtra(":settings:fragment_args_key", "toggle_adb_wireless")
            putExtra(":settings:show_fragment_args", Bundle().apply { putString(":settings:fragment_args_key", "toggle_adb_wireless") })
        }
        for (intent in listOf(withTarget, Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS), Intent(Settings.ACTION_SETTINGS))) {
            try {
                startActivity(intent)
                return true
            } catch (_: Exception) {
                // 换下一个
            }
        }
        return false
    }

    private fun reply(result: MethodChannel.Result, r: kotlin.Result<String>) {
        r.fold(
            { RemoteAdb.lastMessage = it; result.success(it) },
            { RemoteAdb.lastMessage = it.message ?: it.javaClass.simpleName; result.error("adb", RemoteAdb.lastMessage, null) },
        )
    }

    /**
     * 剪贴板里的图片或文件（Flutter 自带的剪贴板只支持文字）：返回名字、类型和内容；剪贴板里没有文件时为 null。
     */
    private fun clipboardFile(): Map<String, Any>? {
        val clip = (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).primaryClip ?: return null
        for (i in 0 until clip.itemCount) {
            val uri = clip.getItemAt(i).uri ?: continue
            val mime = contentResolver.getType(uri) ?: clip.description.getMimeType(0) ?: "application/octet-stream"
            val bytes = try {
                contentResolver.openInputStream(uri)?.use { it.readBytes() }
            } catch (_: Exception) {
                null
            } ?: continue
            var name = "clipboard.${mime.substringAfter('/').substringBefore(';').ifEmpty { "bin" }}"
            try {
                contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst()) c.getString(0)?.let { name = it }
                }
            } catch (_: Exception) {
            }
            return mapOf("name" to name, "mime" to mime, "bytes" to bytes)
        }
        return null
    }

    /** App 内下载更新：进度回到 Flutter，下载完直接拉起系统安装器。 */
    private fun downloadUpdate(url: String, cookie: String) {
        try {
            val dir = File(cacheDir, "updates").apply { mkdirs() }
            val target = File(dir, "projdeck.apk")
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 15_000
                readTimeout = 60_000
                setRequestProperty("Cookie", cookie)
            }
            try {
                if (conn.responseCode !in 200..299) throw IllegalStateException("服务器返回 ${conn.responseCode}")
                val total = conn.contentLengthLong
                var read = 0L
                var last = -1
                conn.inputStream.use { input ->
                    target.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            read += n
                            if (total > 0) {
                                val pct = ((read * 100) / total).toInt().coerceIn(0, 100)
                                if (pct >= last + 2) {
                                    last = pct
                                    runOnUiThread { channel?.invokeMethod("updateProgress", pct) }
                                }
                            }
                        }
                    }
                }
            } finally {
                conn.disconnect()
            }
            if (target.length() <= 0) throw IllegalStateException("下载的文件为空")
            runOnUiThread {
                channel?.invokeMethod("updateProgress", 100)
                installApk(target)
            }
        } catch (e: Exception) {
            runOnUiThread { channel?.invokeMethod("updateError", e.message ?: "下载失败") }
        }
    }

    private fun installApk(file: File) {
        try {
            val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
            startActivity(
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (e: Exception) {
            runCatching {
                startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
            }
            Toast.makeText(this, "请允许安装未知应用，然后重试更新", Toast.LENGTH_LONG).show()
        }
    }

    private fun enable(config: Pair<String, String>) {
        Prefs.setConnection(this, config.first, config.second)
        Prefs.setNotifications(this, true)
        NotifyService.start(this)
    }

    @Deprecated("System document picker callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (harnessViews?.onActivityResult(requestCode, resultCode, data) == true) return
        super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onDestroy() {
        harnessViews?.disposeCache()
        terminalViews?.disposeCache()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_NOTIFY) return
        val ok = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        pendingConfig?.let { if (ok) enable(it) }
        pendingPermission?.success(ok)
        pendingPermission = null
        pendingConfig = null
    }

    /** App 已经开着时点通知：告诉 Dart 去哪个页面。 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(NotifyService.EXTRA_PATH)?.let { channel?.invokeMethod("open", it) }
    }

    companion object {
        private const val REQ_NOTIFY = 2
    }
}
