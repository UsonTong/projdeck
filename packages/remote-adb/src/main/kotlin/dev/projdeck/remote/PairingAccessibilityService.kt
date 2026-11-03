package dev.projdeck.remote

import android.accessibilityservice.AccessibilityService
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * 配对助手：只在配对远程调试时，读取系统「设置」里「与设备配对」窗口显示的配对码和端口，自动完成配对。
 *
 * 系统为了防止被别的 App 盖住，会隐藏设置界面上的悬浮窗，MIUI 的通知栏又不显示通知里的输入框，
 * 所以配对码只能由 App 自己从屏幕上读。权限范围限定为「设置」一个 App（见 res/xml/pairing_accessibility.xml），
 * 配对完成或超时后会自己关闭，需要时再由用户重新打开。
 */
class PairingAccessibilityService : AccessibilityService() {
    private val codeRegex = Regex("""^\d{6}$""")
    private val hostPortRegex = Regex("""(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})""")

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (!PairingState.waiting) return
        val root = rootInActiveWindow ?: return
        val texts = ArrayList<String>()
        collect(root, texts, 0)
        val code = texts.map { it.replace(" ", "") }.firstOrNull { codeRegex.matches(it) } ?: return
        val port = texts.firstNotNullOfOrNull { hostPortRegex.find(it)?.groupValues?.get(2)?.toIntOrNull() } ?: return
        // 只配一次：等配对线程出结果之前不再重复触发
        if (!PairingState.waiting) return
        PairingState.waiting = false
        Log.i(TAG, "读到配对窗口 port=$port codeLen=${code.length}")
        RemoteAdb.async({
            RemoteAdb.pair(this, "127.0.0.1", port, code)
            // 这时无线调试还开着：顺便让 App 自己拥有授权，之后重启也能自动恢复
            runCatching { RemoteAdb.grantSelf(this) }.onFailure { Log.e(TAG, "配对后自动授权失败", it) }
        }) { r ->
            val failed = r.exceptionOrNull()
            if (failed != null) Log.e(TAG, "配对失败", failed) else Log.i(TAG, "配对成功 secure=${RemoteAdb.hasSecure(this)}")
            val message = r.fold(
                { "配对成功" + if (RemoteAdb.hasSecure(this)) "，已授权" else "，授权还没成功（可以回 App 里再试）" },
                { "配对失败：${it.message ?: it.javaClass.simpleName}" },
            )
            RemoteAdb.lastMessage = message
            PairingState.onResult?.invoke(message)
            // 用完就关，只在配对时才有这个权限
            disableSelf()
        }
    }

    private fun collect(node: AccessibilityNodeInfo, out: MutableList<String>, depth: Int) {
        if (depth > 30) return
        node.text?.toString()?.takeIf { it.isNotBlank() }?.let(out::add)
        node.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let(out::add)
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            collect(child, out, depth + 1)
        }
    }

    override fun onInterrupt() {}

    companion object {
        private const val TAG = "ProjdeckAdb"
    }
}
