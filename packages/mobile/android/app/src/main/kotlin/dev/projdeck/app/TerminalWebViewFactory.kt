package dev.projdeck.app

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory
import org.json.JSONObject

/**
 * 安卓原生端的 Ghostty 终端：WebView 加载 projdeck 网页里的纯终端页（ghostty-web WASM），
 * 和网页端使用同一个终端引擎。主密钥仍只写入 HttpOnly Cookie。
 *
 * 加载整个网页和 WASM 要一会儿，所以 WebView 在会话页关闭时不销毁：停到空白的 #/idle（断开终端，
 * 让电脑上的 pane 恢复尺寸）后留着，下次打开终端只改 hash 切到新的 pane。
 */
class TerminalWebViewFactory(private val activity: Activity) : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
    private data class Cached(val origin: String, val web: WebView, val loaded: Boolean)

    private var cached: Cached? = null

    /** 当前显示着 WebView 的视图。左右滑切换会话时新页面先于旧页面销毁创建，直接接管它的 WebView。 */
    private var current: TerminalView? = null

    override fun create(context: Context, viewId: Int, args: Any?): PlatformView = TerminalView(context, args as? Map<*, *>)

    /** Activity 真正销毁时清掉保留的 WebView，避免泄漏。 */
    fun disposeCache() {
        current?.release()?.web?.destroyQuietly()
        cached?.web?.destroyQuietly()
        cached = null
    }

    private fun WebView.destroyQuietly() {
        (parent as? ViewGroup)?.removeView(this)
        stopLoading()
        destroy()
    }

    private inner class TerminalView(context: Context, params: Map<*, *>?) : PlatformView {
        private var web: WebView? = null
        private var origin: String? = null
        private var pageLoaded = false
        private var disposed = false
        private val root = object : FrameLayout(context) {
            override fun checkInputConnectionProxy(view: View?): Boolean =
                web?.checkInputConnectionProxy(view) == true || super.checkInputConnectionProxy(view)
        }

        init {
            val base = HarnessWebActivity.trustedOrigin(params?.get("base") as? String)
            val paneId = params?.get("paneId") as? String
            if (base == null || paneId.isNullOrBlank()) {
                errorView("终端参数无效")
            } else {
                origin = base
                val previous = cached ?: current?.release()
                cached = null
                if (previous != null && previous.origin != base) previous.web.destroyQuietly()
                val reusable = previous?.takeIf { it.origin == base }
                try {
                    if (reusable != null && reusable.loaded) {
                        // 网页和 WASM 已经启动好：只切换 hash，终端页按新的 pane 重新连接
                        attach(reusable.web, loaded = true)
                        reusable.web.evaluateJavascript("location.replace(${JSONObject.quote(route(paneId))})", null)
                    } else {
                        val browser = reusable?.web ?: WebView(context)
                        attach(browser, loaded = false)
                        HarnessWebActivity.authenticate(activity, base, params?.get("key") as? String) { origin ->
                            if (disposed || web !== browser) return@authenticate
                            if (origin == null) errorView("无法认证终端，请检查连接")
                            else browser.loadUrl("$origin/${route(paneId)}")
                        }
                    }
                } catch (_: Exception) {
                    errorView("无法打开 Ghostty 终端，请检查系统 WebView")
                }
            }
        }

        private fun route(paneId: String) = "#/t/${Uri.encode(paneId)}"

        private fun attach(browser: WebView, loaded: Boolean) {
            web = browser
            current = this
            pageLoaded = loaded
            (browser.parent as? ViewGroup)?.removeView(browser)
            // 页面加载出来之前透出 Flutter 的背景，而不是一块白屏
            browser.setBackgroundColor(Color.TRANSPARENT)
            root.addView(browser, FrameLayout.LayoutParams(-1, -1))
            HarnessWebActivity.configureWebView(browser, origin!!, chooseFiles = { _, _ -> }, onPageFinished = { _, _ ->
                pageLoaded = true
            })
        }

        /** 交出 WebView 给新打开的会话页（本页面正在退场）。 */
        fun release(): Cached? {
            val browser = web ?: return null
            if (current === this) current = null
            root.removeAllViews()
            web = null
            return Cached(origin ?: "", browser, pageLoaded)
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
            if (current === this) current = null
            val browser = web ?: return
            web = null
            root.removeAllViews()
            if (!pageLoaded) {
                // 还没加载完的页面不值得留：直接销毁
                browser.destroyQuietly()
                return
            }
            // 离开终端：断开 attach，电脑上的 pane 立刻恢复尺寸；网页本身留着下次用
            browser.evaluateJavascript("location.replace('#/idle')", null)
            cached?.web?.takeIf { it !== browser }?.destroyQuietly()
            cached = Cached(origin ?: "", browser, true)
        }
    }
}
