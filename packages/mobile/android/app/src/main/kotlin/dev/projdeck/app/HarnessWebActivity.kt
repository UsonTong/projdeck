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

/** 顶栏 D 的高级入口；嵌入会话复用下方的安全配置，不创建 Activity。 */
class HarnessWebActivity : Activity() {
    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val base = trustedOrigin(intent.getStringExtra(EXTRA_ORIGIN))
        if (base == null) {
            finish()
            return
        }
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
        configureWebView(web, base, chooseFiles = { callback, picker ->
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            try {
                startActivityForResult(picker, REQ_FILES)
            } catch (_: Exception) {
                fileCallback?.onReceiveValue(null)
                fileCallback = null
                Toast.makeText(this, "无法打开系统文件选择器", Toast.LENGTH_SHORT).show()
            }
        }, openExternal = ::openExternal)
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { goBackOrClose() }
        }
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            // 手机屏幕放不下原版 280px 侧栏；单独的入口也使用嵌入模式，只显示聊天。
            web.loadUrl("$base/harness/?embed=1")
        }
    }

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
        callback?.onReceiveValue(selectedFiles(resultCode, data))
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

        fun trustedOrigin(base: String?): String? = try {
            val uri = URI(base ?: "")
            val scheme = uri.scheme?.lowercase()
            if (scheme !in setOf("http", "https") || uri.host.isNullOrEmpty() ||
                uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null ||
                uri.rawPath !in listOf("", "/") || uri.port !in -1..65535 || uri.port == 0
            ) null else URI(scheme, null, uri.host, uri.port, null, null, null).toASCIIString()
        } catch (_: Exception) {
            null
        }

        /** 无 JS bridge，无 file/content URL 访问；内嵌模式不允许打开外站。 */
        fun configureWebView(
            web: WebView,
            base: String,
            chooseFiles: (ValueCallback<Array<Uri>>, Intent) -> Unit,
            openExternal: ((Uri) -> Unit)? = null,
        ) {
            val origin = Uri.parse(base)
            fun sameOrigin(uri: Uri): Boolean =
                uri.scheme.equals(origin.scheme, ignoreCase = true) &&
                    uri.host.equals(origin.host, ignoreCase = true) &&
                    effectivePort(uri) == effectivePort(origin) && uri.userInfo == null
            fun blocked() = WebResourceResponse(
                "text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)),
            )
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
                setSupportMultipleWindows(false)
                javaScriptCanOpenWindowsAutomatically = false
            }
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
            web.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (sameOrigin(request.url)) return false
                    if (request.isForMainFrame && request.hasGesture()) openExternal?.invoke(request.url)
                    return true
                }

                @Suppress("DEPRECATION")
                override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                    val uri = Uri.parse(url)
                    if (sameOrigin(uri)) return false
                    openExternal?.invoke(uri)
                    return true
                }

                override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                    if (!sameOrigin(Uri.parse(url))) view.stopLoading()
                }

                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    if (sameOrigin(request.url)) null else blocked()
            }
            web.webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams,
                ): Boolean {
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
                    chooseFiles(callback, picker)
                    return true
                }
            }
        }

        fun selectedFiles(resultCode: Int, data: Intent?): Array<Uri>? {
            val uris = if (resultCode == RESULT_OK) {
                val clip = data?.clipData
                if (clip != null) (0 until clip.itemCount).map { clip.getItemAt(it).uri }
                else listOfNotNull(data?.data)
            } else emptyList()
            return uris.filter { it.scheme == "content" }.distinct().takeIf { it.isNotEmpty() }?.toTypedArray()
        }

        /** 主密钥只通过 host-only HttpOnly Cookie 进入 WebView，不进入 URL / JS。 */
        fun authenticate(activity: Activity, base: String?, key: String?, done: (String?) -> Unit) {
            val origin = trustedOrigin(base)
            if (origin == null || key.isNullOrEmpty() || !key.matches(Regex("[\\x21\\x23-\\x2B\\x2D-\\x3A\\x3C-\\x5B\\x5D-\\x7E]+"))) {
                done(null)
                return
            }
            try {
                val cookies = CookieManager.getInstance()
                cookies.setAcceptCookie(true)
                val secure = if (origin.startsWith("https:")) "; Secure" else ""
                cookies.setCookie("$origin/", "projdeck_key=$key; Path=/; HttpOnly; SameSite=Lax$secure") { accepted ->
                    done(if (accepted && !activity.isFinishing && !activity.isDestroyed) origin else null)
                }
            } catch (_: Exception) {
                done(null)
            }
        }

        fun open(activity: Activity, base: String?, key: String?, done: (Boolean) -> Unit) {
            authenticate(activity, base, key) { origin ->
                if (origin == null) {
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
        }
    }
}
