package dev.projdeck.app

import android.app.Activity
import android.content.Context
import android.net.Uri
import android.view.View
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory

/**
 * 安卓原生端的 Ghostty 终端：WebView 加载 projdeck 网页里的纯终端页（ghostty-web WASM），
 * 和网页端使用同一个终端引擎。主密钥仍只写入 HttpOnly Cookie。
 */
class TerminalWebViewFactory(private val activity: Activity) : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
    override fun create(context: Context, viewId: Int, args: Any?): PlatformView = TerminalView(context, args as? Map<*, *>)

    private inner class TerminalView(context: Context, params: Map<*, *>?) : PlatformView {
        private var web: WebView? = null
        private val root = object : FrameLayout(context) {
            override fun checkInputConnectionProxy(view: View?): Boolean =
                web?.checkInputConnectionProxy(view) == true || super.checkInputConnectionProxy(view)
        }
        private var disposed = false

        init {
            val base = HarnessWebActivity.trustedOrigin(params?.get("base") as? String)
            val paneId = params?.get("paneId") as? String
            if (base == null || paneId.isNullOrBlank()) {
                errorView("终端参数无效")
            } else {
                try {
                    val browser = WebView(context)
                    web = browser
                    root.addView(browser, FrameLayout.LayoutParams(-1, -1))
                    HarnessWebActivity.configureWebView(browser, base, chooseFiles = { _, _ -> })
                    HarnessWebActivity.authenticate(activity, base, params?.get("key") as? String) { origin ->
                        if (disposed) return@authenticate
                        if (origin == null) errorView("无法认证终端，请检查连接")
                        else browser.loadUrl("$origin/#/t/${Uri.encode(paneId)}")
                    }
                } catch (_: Exception) {
                    errorView("无法打开 Ghostty 终端，请检查系统 WebView")
                }
            }
        }

        private fun errorView(message: String) {
            root.removeAllViews()
            root.addView(TextView(root.context).apply {
                text = message
                gravity = android.view.Gravity.CENTER
            }, FrameLayout.LayoutParams(-1, -1))
        }

        override fun getView(): View = root

        override fun dispose() {
            disposed = true
            root.removeAllViews()
            web?.apply {
                stopLoading()
                webChromeClient = null
                destroy()
            }
            web = null
        }
    }
}
