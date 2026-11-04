package dev.projdeck.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.webkit.ValueCallback
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory

/** SessionPage 内容区的同源 WebView。只有系统文件选择回调进入 MainActivity。 */
class HarnessWebViewFactory(private val activity: Activity) : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
    private var pendingOwner: PlatformView? = null
    private var pendingFiles: ValueCallback<Array<Uri>>? = null

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

    private inner class HarnessView(context: Context, params: Map<*, *>?) : PlatformView {
        private var web: WebView? = null
        private val root = object : FrameLayout(context) {
            override fun checkInputConnectionProxy(view: View?): Boolean =
                web?.checkInputConnectionProxy(view) == true || super.checkInputConnectionProxy(view)
        }
        private var disposed = false

        init {
            val base = HarnessWebActivity.trustedOrigin(params?.get("base") as? String)
            val sessionId = params?.get("sessionId") as? String
            if (base == null || sessionId.isNullOrBlank()) {
                showError("Harness 连接或会话无效")
            } else {
                try {
                    val browser = WebView(context)
                    web = browser
                    root.addView(browser, FrameLayout.LayoutParams(-1, -1))
                    HarnessWebActivity.configureWebView(browser, base, chooseFiles = { callback, picker ->
                        chooseFiles(this, callback, picker)
                    })
                    HarnessWebActivity.authenticate(activity, base, params?.get("key") as? String) { origin ->
                        if (!disposed) {
                            if (origin == null) {
                                showError("无法认证 Harness，请检查连接配置")
                            } else {
                                // session is the original Harness ID, never the projdeck pane ID.
                                // The server's embed script hides its sidebar and selects this chat.
                                val url = Uri.parse("$origin/harness/").buildUpon()
                                    .appendQueryParameter("embed", "1")
                                    .appendQueryParameter("session", sessionId)
                                    .build()
                                browser.loadUrl(url.toString())
                            }
                        }
                    }
                } catch (_: Exception) {
                    showError("无法打开 Harness，请检查系统 WebView")
                }
            }
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
            root.removeAllViews()
            web?.apply {
                stopLoading()
                webChromeClient = null
                destroy()
            }
            web = null
        }
    }

    companion object {
        private const val REQ_FILES = 0x5044
    }
}
