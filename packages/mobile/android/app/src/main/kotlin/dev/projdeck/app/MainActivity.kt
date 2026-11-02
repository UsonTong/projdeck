package dev.projdeck.app

import android.Manifest
import android.app.DownloadManager
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.provider.OpenableColumns
import android.content.pm.PackageManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Flutter 的宿主。通过 projdeck/native 通道给 Dart 提供：后台通知的开关（需要通知权限）、
 * 以及点通知打开 App 时要去的页面。
 */
class MainActivity : FlutterActivity() {
    private var channel: MethodChannel? = null
    private var pendingPermission: MethodChannel.Result? = null
    private var pendingConfig: Pair<String, String>? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val ch = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "projdeck/native")
        channel = ch
        ch.setMethodCallHandler { call, result ->
            when (call.method) {
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
                "adbStatus" -> RemoteAdb.async({ RemoteAdb.status(this) }) { r -> r.fold({ result.success(it) }, { result.error("adb", it.message, null) }) }
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
                "openDeveloperSettings" -> result.success(openDeveloperSettings())
                "openAccessibilitySettings" -> {
                    startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    result.success(true)
                }
                "adbGrantSelf" -> RemoteAdb.async({ RemoteAdb.grantSelf(this) }) { r -> reply(result, r) }
                "adbEnableTcp" -> RemoteAdb.async({ RemoteAdb.enableTcp(this) }) { r -> reply(result, r) }
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
        // 已经开着通知：确保后台连接在跑（例如被系统清理后重新打开 App）
        if (Prefs.notificationsEnabled(this)) NotifyService.start(this)
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

    private fun enable(config: Pair<String, String>) {
        Prefs.setConnection(this, config.first, config.second)
        Prefs.setNotifications(this, true)
        NotifyService.start(this)
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
