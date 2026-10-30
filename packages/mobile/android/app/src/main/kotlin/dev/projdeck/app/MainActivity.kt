package dev.projdeck.app

import android.Manifest
import android.content.Intent
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
                else -> result.notImplemented()
            }
        }
        // 已经开着通知：确保后台连接在跑（例如被系统清理后重新打开 App）
        if (Prefs.notificationsEnabled(this)) NotifyService.start(this)
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
