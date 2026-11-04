package dev.projdeck.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedDispatcher
import java.io.ByteArrayInputStream
import java.net.URI

/** 只承载受 projdeck 主密钥保护的同源原版页面，不提供任何 JS bridge。 */
class HarnessWebActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var origin: Uri
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val base = trustedOrigin(intent.getStringExtra(EXTRA_ORIGIN))
        if (base == null) {
            finish()
            return
        }
        origin = Uri.parse(base)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            fitsSystemWindows = true
        }
        val toolbar = LinearLayout(this)
        toolbar.addView(Button(this).apply {
            text = "返回"
            setOnClickListener { goBackOrClose() }
        })
        toolbar.addView(TextView(this).apply {
            text = "DeepSeek Harness"
            gravity = android.view.Gravity.CENTER_VERTICAL
            textSize = 16f
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f))
        toolbar.addView(Button(this).apply {
            text = "刷新"
            setOnClickListener { web.reload() }
        })
        root.addView(toolbar)
        web = WebView(this)
        root.addView(web, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // 新窗口链接仍走当前 WebView 的同源 / 外链导航检查。
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (isSameOrigin(request.url)) return false
                if (request.isForMainFrame && request.hasGesture()) openExternal(request.url)
                return true
            }

            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                val uri = Uri.parse(url)
                if (isSameOrigin(uri)) return false
                openExternal(uri)
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                if (!isSameOrigin(Uri.parse(url))) view.stopLoading()
            }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (isSameOrigin(request.url)) return null
                // 不让 iframe / 子资源偷偷内嵌外站；也不把 Cookie 转交给外链。
                return WebResourceResponse(
                    "text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)),
                )
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val types = params.acceptTypes.flatMap { it.split(',') }.map { it.trim() }
                    .filter { it.matches(Regex("[\\w.+-]+/(?:[\\w.+-]+|\\*)")) }
                    .ifEmpty { listOf("*/*") }
                val picker = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = if (types.size == 1) types.first() else "*/*"
                    if (types.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                try {
                    startActivityForResult(picker, REQ_FILES)
                } catch (_: Exception) {
                    fileCallback?.onReceiveValue(null)
                    fileCallback = null
                    Toast.makeText(this@HarnessWebActivity, "无法打开系统文件选择器", Toast.LENGTH_SHORT).show()
                }
                return true
            }
        }
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { goBackOrClose() }
        }
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl("$base/harness/")
        }
    }

    private fun isSameOrigin(uri: Uri): Boolean =
        uri.scheme.equals(origin.scheme, ignoreCase = true) &&
            uri.host.equals(origin.host, ignoreCase = true) &&
            effectivePort(uri) == effectivePort(origin) && uri.userInfo == null

    private fun openExternal(uri: Uri) {
        if (uri.scheme?.lowercase() !in setOf("https", "http", "mailto", "tel", "sms", "geo")) return
        if (uri.userInfo != null) return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: Exception) {
            Toast.makeText(this, "没有可打开此链接的应用", Toast.LENGTH_SHORT).show()
        }
    }

    private fun goBackOrClose() {
        if (web.canGoBack()) web.goBack() else finish()
    }

    @Deprecated("Used on Android 12 and earlier")
    override fun onBackPressed() = goBackOrClose()

    override fun onSaveInstanceState(outState: Bundle) {
        if (::web.isInitialized) web.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("System document picker callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_FILES) return
        val callback = fileCallback
        fileCallback = null
        val uris = if (resultCode == RESULT_OK) {
            val clip = data?.clipData
            if (clip != null) (0 until clip.itemCount).map { clip.getItemAt(it).uri }
            else listOfNotNull(data?.data)
        } else emptyList()
        callback?.onReceiveValue(uris.filter { it.scheme == "content" }.distinct().takeIf { it.isNotEmpty() }?.toTypedArray())
    }

    override fun onDestroy() {
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        if (::web.isInitialized) {
            (web.parent as? android.view.ViewGroup)?.removeView(web)
            web.stopLoading()
            web.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val EXTRA_ORIGIN = "harness_origin"
        private const val REQ_FILES = 41

        private fun effectivePort(uri: Uri) = if (uri.port != -1) uri.port else if (uri.scheme == "https") 443 else 80

        private fun trustedOrigin(base: String?): String? = try {
            val uri = URI(base ?: "")
            val scheme = uri.scheme?.lowercase()
            if (scheme !in setOf("http", "https") || uri.host.isNullOrEmpty() ||
                uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null ||
                uri.rawPath !in listOf("", "/") || uri.port !in -1..65535 || uri.port == 0
            ) null else URI(scheme, null, uri.host, uri.port, null, null, null).toASCIIString()
        } catch (_: Exception) {
            null
        }

        fun open(activity: Activity, base: String?, key: String?, done: (Boolean) -> Unit) {
            val origin = trustedOrigin(base)
            // RFC 6265 cookie-octet：不允许分号、换行等造成 Cookie 注入。
            if (origin == null || key.isNullOrEmpty() || !key.matches(Regex("[\\x21\\x23-\\x2B\\x2D-\\x3A\\x3C-\\x5B\\x5D-\\x7E]+"))) {
                done(false)
                return
            }
            try {
                val cookies = CookieManager.getInstance()
                cookies.setAcceptCookie(true)
                val secure = if (origin.startsWith("https:")) "; Secure" else ""
                // Host-only，无 Domain；不在 URL、Intent、日志或 JS 中传递密钥。
                cookies.setCookie("$origin/", "projdeck_key=$key; Path=/; HttpOnly; SameSite=Lax$secure") { accepted ->
                    if (!accepted || activity.isFinishing || activity.isDestroyed) {
                        done(false)
                    } else {
                        try {
                            activity.startActivity(Intent(activity, HarnessWebActivity::class.java).putExtra(EXTRA_ORIGIN, origin))
                            done(true)
                        } catch (_: Exception) {
                            done(false)
                        }
                    }
                }
            } catch (_: Exception) {
                done(false)
            }
        }
    }
}
