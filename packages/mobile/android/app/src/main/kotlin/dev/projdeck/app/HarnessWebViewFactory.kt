package dev.projdeck.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory
import org.json.JSONObject

/**
 * SessionPage 内容区的同源 WebView。只有系统文件选择回调进入 MainActivity。
 *
 * WebView 在页面关闭时只从视图树摘下、不销毁；下次进入 DeepSeek 会话时复用已经启动好的
 * Harness 前端，通过自定义事件切换会话，避免每次都等 “Loading plugins…”。
 */
class HarnessWebViewFactory(private val activity: Activity) : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
    private var pendingOwner: PlatformView? = null
    private var pendingFiles: ValueCallback<Array<Uri>>? = null
    private var cached: Cached? = null

    override fun create(context: Context, viewId: Int, args: Any?): PlatformView = HarnessView(context, args as? Map<*, *>)

    private fun chooseFiles(owner: PlatformView, callback: ValueCallback<Array<Uri>>, picker: Intent) {
        pendingFiles?.onReceiveValue(null)
        pendingOwner = owner
        pendingFiles = callback
        try {
            activity.startActivityForResult(picker, REQ_FILES)
        } catch (_: Exception) {
            cancelFiles(owner)
            Toast.makeText(activity, "无法打开系统文件选择器", Toast.LENGTH_SHORT).show()
        }
    }

    private fun cancelFiles(owner: PlatformView) {
        if (pendingOwner !== owner) return
        val callback = pendingFiles
        pendingFiles = null
        pendingOwner = null
        callback?.onReceiveValue(null)
    }

    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQ_FILES) return false
        val callback = pendingFiles
        pendingFiles = null
        pendingOwner = null
        callback?.onReceiveValue(HarnessWebActivity.selectedFiles(resultCode, data))
        return true
    }

    /** Activity 真正销毁时清掉保留的 WebView，避免泄漏。 */
    fun disposeCache() {
        current?.release()?.web?.let { web ->
            web.stopLoading()
            web.destroy()
        }
        cached?.web?.let { web ->
            (web.parent as? ViewGroup)?.removeView(web)
            web.stopLoading()
            web.destroy()
        }
        cached = null
    }

    private data class Cached(val origin: String, val web: WebView, var sessionId: String?, var loaded: Boolean)

    /** 当前显示着 WebView 的视图。切换会话时新页面先于旧页面销毁创建，直接接管旧页面已启动的 WebView。 */
    private var current: HarnessView? = null

    private inner class HarnessView(context: Context, params: Map<*, *>?) : PlatformView {
        private var web: WebView? = null
        private var origin: String? = null
        private var sessionId: String? = null
        private var pageLoaded = false
        private var pendingSession: String? = null
        private var disposed = false
        private val root = object : FrameLayout(context) {
            override fun checkInputConnectionProxy(view: View?): Boolean =
                web?.checkInputConnectionProxy(view) == true || super.checkInputConnectionProxy(view)
        }

        init {
            val base = HarnessWebActivity.trustedOrigin(params?.get("base") as? String)
            val session = params?.get("sessionId") as? String
            if (base == null || session.isNullOrBlank()) {
                showError("Harness 连接或会话无效")
            } else {
                origin = base
                sessionId = session
                val previous = cached ?: current?.release()
                cached = null
                if (previous != null && previous.origin != base) {
                    previous.web.apply {
                        stopLoading()
                        destroy()
                    }
                }
                val reusable = previous?.takeIf { it.origin == base }
                if (reusable != null && reusable.loaded) {
                    attach(reusable.web, session, reusable)
                } else {
                    // 没有可复用的，或复用的页面还没加载完：按新会话的地址（重新）加载。
                    // 加载中的页面不能靠事件切换，嵌入脚本可能还没开始监听，会停在旧地址里的会话。
                    try {
                        val browser = reusable?.web ?: WebView(context)
                        attach(browser, session, null)
                        HarnessWebActivity.authenticate(activity, base, params?.get("key") as? String) { origin ->
                            if (!disposed && web === browser) {
                                if (origin == null) showError("无法认证 Harness，请检查连接配置")
                                else loadSession(browser, session)
                            }
                        }
                    } catch (_: Exception) {
                        showError("无法打开 Harness，请检查系统 WebView")
                    }
                }
            }
        }

        private fun attach(browser: WebView, session: String, previous: Cached?) {
            web = browser
            current = this
            sessionId = session
            pageLoaded = previous?.loaded ?: false
            (browser.parent as? ViewGroup)?.removeView(browser)
            root.addView(browser, FrameLayout.LayoutParams(-1, -1))
            HarnessWebActivity.configureWebView(browser, origin!!, chooseFiles = { callback, picker ->
                chooseFiles(this, callback, picker)
            }, onPageFinished = { view, _ ->
                pageLoaded = true
                flush(view)
            })
            if (previous != null) {
                // 复用已启动的页面：不重新加载，通过事件切换会话
                if (previous.sessionId == session) return
                pendingSession = session
                flush(browser)
            }
        }

        /** 交出 WebView 给新打开的会话页（本页面正在退场）。 */
        fun release(): Cached? {
            val browser = web ?: return null
            if (current === this) current = null
            cancelFiles(this)
            root.removeAllViews()
            web = null
            return Cached(origin ?: "", browser, sessionId, pageLoaded)
        }

        private fun loadSession(browser: WebView, session: String) {
            val url = Uri.parse("$origin/harness/").buildUpon()
                .appendQueryParameter("embed", "1")
                .appendQueryParameter("session", session)
                .build()
            pageLoaded = false
            browser.loadUrl(url.toString())
            sessionId = session
        }

        private fun flush(browser: WebView) {
            val next = pendingSession ?: return
            if (!pageLoaded) return
            pendingSession = null
            sessionId = next
            browser.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('projdeck-select',{detail:${JSONObject.quote(next)}}))",
                null,
            )
        }

        private fun showError(message: String) {
            root.removeAllViews()
            root.addView(TextView(root.context).apply {
                text = message
                gravity = android.view.Gravity.CENTER
            }, FrameLayout.LayoutParams(-1, -1))
        }

        override fun getView(): View = root

        override fun dispose() {
            disposed = true
            cancelFiles(this)
            if (current === this) current = null
            val browser = web ?: return
            root.removeAllViews()
            if (browser.parent != null) (browser.parent as? ViewGroup)?.removeView(browser)
            // Keep the fully booted SPA for the next DeepSeek session; only Activity teardown destroys it.
            cached?.web?.takeIf { it !== browser }?.let { old ->
                old.stopLoading()
                old.destroy()
            }
            cached = Cached(origin ?: "", browser, sessionId, pageLoaded)
            web = null
        }
    }

    companion object {
        private const val REQ_FILES = 0x5044
    }
}
